'use strict';

var utils = require('./pouch-utils');
var lunr = require('lunr');
var uniq = require('uniq');
var Promise = utils.Promise;

var index = lunr();

var TYPE_TOKEN_COUNT = 'a';
var TYPE_DOC_INFO = 'b';

function add(left, right) {
  return left + right;
}

function getTokenStream(text) {
  return index.pipeline.run(lunr.tokenizer(text));
}

exports.search = utils.toPromise(function (opts, callback) {
  var pouch = this;
  opts = utils.extend(true, {}, opts);
  var q = opts.query || opts.q;
  var mm = 'mm' in opts ? (parseFloat(opts.mm) / 100) : 1; // e.g. '75%'
  var fields = opts.fields;
  var highlighting = opts.highlighting;
  var includeDocs = opts.include_docs;
  var persistedIndexName = 'search-' + utils.MD5(JSON.stringify(fields));
  var destroy = opts.destroy;
  var stale = opts.stale;

  var fieldBoosts;
  if (Array.isArray(fields)) {
    fieldBoosts = fields.map(function (field) {
      return {field: field, boost: 1};
    });
  } else { // object
    fieldBoosts = Object.keys(fields).map(function (field) {
      return {field: field, boost: fields[field]};
    });
  }

  var mapFun = function (doc, emit) {
    var docInfo = [];
    fieldBoosts.forEach(function (fieldBoost, fieldIdx) {
      var text = doc[fieldBoost.field];
      var fieldLenNorm;
      if (text) {
        var terms = getTokenStream(text);
        terms.forEach(function (term) {
          // avoid emitting the value if there's only one field;
          // it takes up unnecessary space on disk
          var value = fieldBoosts.length > 1 ? fieldIdx : undefined;
          emit(TYPE_TOKEN_COUNT + term, value);
        });
        fieldLenNorm = Math.sqrt(terms.length);
      } else {
        fieldLenNorm = 0;
      }
      docInfo.push(fieldLenNorm);
    });

    emit(TYPE_DOC_INFO + doc._id, docInfo);
  };

  var queryOpts = {
    saveAs: persistedIndexName
  };
  if (destroy) {
    queryOpts.destroy = true;
    return pouch.query(mapFun, queryOpts, callback);
  }

  // usually it doesn't matter if the user types the same
  // token more than once, in fact I think even Lucene does this
  var queryTerms = uniq(getTokenStream(q));
  if (!queryTerms.length) {
    return callback(null, {rows: []});
  }
  queryOpts.keys = queryTerms.map(function (queryTerm) {
    return TYPE_TOKEN_COUNT + queryTerm;
  });

  if (typeof stale === 'string') {
    queryOpts.stale = stale;
  }

  // search algorithm, basically classic TF-IDF
  //
  // step 1: get the docs associated with the terms in the query
  // step 2: get the doc-len-norms of those documents
  // step 3: calculate cosine similarity using tf-idf
  //
  // note that we follow the Lucene convention (established in
  // DefaultSimilarity.java) of computing doc-len-norm as
  // Math.sqrt(numTerms)
  // which is an optimization that avoids having to look up every term
  // in that document and fully recompute its scores based on tf-idf
  // More info:
  // https://lucene.apache.org/core/3_6_0/api/core/org/apache/lucene/search/Similarity.html
  //

  // step 1
  pouch.query(mapFun, queryOpts).then(function (res) {

    if (!res.rows.length) {
      return callback(null, {rows: []});
    }

    var docIdsToFieldsToQueryTerms = {};
    var termDFs = {};

    res.rows.forEach(function (row) {
      var term = row.key.substring(1);
      var field = row.value || 0;

      // calculate termDFs
      if (!(term in termDFs)) {
        termDFs[term] = 1;
      } else {
        termDFs[term]++;
      }

      // calculate docIdsToFieldsToQueryTerms
      if (!(row.id in docIdsToFieldsToQueryTerms)) {
        var arr = docIdsToFieldsToQueryTerms[row.id] = [];
        for (var i = 0; i < fieldBoosts.length; i++) {
          arr[i] = {};
        }
      }

      var docTerms = docIdsToFieldsToQueryTerms[row.id][field];
      if (!(term in docTerms)) {
        docTerms[term] = 1;
      } else {
        docTerms[term]++;
      }
    });

    // apply the minimum should match (mm)
    if (queryTerms.length > 1) {
      Object.keys(docIdsToFieldsToQueryTerms).forEach(function (docId) {
        var allMatchingTerms = {};
        var fieldsToQueryTerms = docIdsToFieldsToQueryTerms[docId];
        Object.keys(fieldsToQueryTerms).forEach(function (field) {
          Object.keys(fieldsToQueryTerms[field]).forEach(function (term) {
            allMatchingTerms[term] = true;
          });
        });
        var numMatchingTerms = Object.keys(allMatchingTerms).length;
        var matchingRatio = numMatchingTerms / queryTerms.length;
        if ((Math.floor(matchingRatio * 100) / 100) < mm) {
          delete docIdsToFieldsToQueryTerms[docId]; // ignore this doc
        }
      });
    }

    if (!Object.keys(docIdsToFieldsToQueryTerms).length) {
      return callback(null, {rows: []});
    }

    var keys = Object.keys(docIdsToFieldsToQueryTerms).map(function (docId) {
      return TYPE_DOC_INFO + docId;
    });

    var queryOpts = {
      saveAs: persistedIndexName,
      keys: keys
    };

    // step 2
    return pouch.query(mapFun, queryOpts).then(function (res) {

      var docIdsToFieldsToNorms = {};
      res.rows.forEach(function (row) {
        docIdsToFieldsToNorms[row.id] = row.value;
      });
      // step 3
      // now we have all information, so calculate cosine similarity
      var rows = calculateCosineSim(queryTerms, termDFs,
        docIdsToFieldsToQueryTerms, docIdsToFieldsToNorms, fieldBoosts);
      return rows;
    }).then(function (rows) {
      if (includeDocs) {
        return applyIncludeDocs(pouch, rows);
      }
      return rows;
    }).then(function (rows) {
      if (highlighting) {
        return applyHighlighting(pouch, opts, rows, fieldBoosts, docIdsToFieldsToQueryTerms);
      }
      return rows;

    }).then(function (rows) {
      callback(null, {rows: rows});
    });
  }).catch(callback);
});


function calculateCosineSim(queryTerms, termDFs, docIdsToFieldsToQueryTerms,
                            docIdsToFieldsToNorms, fieldBoosts) {
  // calculate cosine similarity using tf-idf, which is equal to
  // dot-product(q, d) / (norm(q) * norm(doc))
  // although there is no point in calculating the query norm,
  // because all we care about is the relative score for a given query,
  // so we ignore it (lucene does this too)
  //
  // then we return a sorted list of results, like:
  // [{id: {...}, score: 0.2}, {id: {...}, score: 0.1}];
  //
  // we also implement the dismax algorithm here, so the doc score is the
  // sum of its fields' scores, and this is done on a per-query-term basis,
  // then the maximum score for each of the query terms is the one chosen
  //

  var results = Object.keys(docIdsToFieldsToQueryTerms).map(function (docId) {

    var fieldsToQueryTerms = docIdsToFieldsToQueryTerms[docId];
    var fieldsToNorms = docIdsToFieldsToNorms[docId];

    var queryScores = queryTerms.map(function (queryTerm) {
      return fieldsToQueryTerms.map(function (queryTermsToCounts, fieldIdx) {
        var fieldNorm = fieldsToNorms[fieldIdx];
        if (!(queryTerm in queryTermsToCounts)) {
          return 0;
        }
        var termDF = termDFs[queryTerm];
        var termTF = queryTermsToCounts[queryTerm];
        var docScore = termTF / termDF; // TF-IDF for doc
        var queryScore = 1 / termDF; // TF-IDF for query, count assumed to be 1
        var boost = fieldBoosts[fieldIdx].boost;
        return docScore * queryScore * boost / fieldNorm;
      }).reduce(add, 0);
    });

    var maxQueryScore = 0;
    queryScores.forEach(function (queryScore) {
      if (queryScore > maxQueryScore) {
        maxQueryScore = queryScore;
      }
    });

    return {
      id: docId,
      score: maxQueryScore
    };
  });

  results.sort(function (a, b) {
    return a.score < b.score ? 1 : (a.score > b.score ? -1 : 0);
  });

  return results;
}

function applyIncludeDocs(pouch, rows) {
  return Promise.all(rows.map(function (row) {
    return pouch.get(row.id);
  })).then(function (docs) {
    docs.forEach(function (doc, i) {
      rows[i].doc = doc;
    });
  }).then(function () {
    return rows;
  });
}

// create a convenient object showing highlighting results
// this is designed to be like solr's highlighting feature, so it
// should return something like
// {'fieldname': 'here is some <strong>highlighted text</strong>.'}
//
function applyHighlighting(pouch, opts, rows, fieldBoosts,
                           docIdsToFieldsToQueryTerms) {

  var pre = opts.highlighting_pre || '<strong>';
  var post = opts.highlighting_post || '</strong>';

  return Promise.all(rows.map(function (row) {

    return Promise.resolve().then(function () {
      if (row.doc) {
        return row.doc;
      }
      return pouch.get(row.id);
    }).then(function (doc) {
      row.highlighting = {};
      docIdsToFieldsToQueryTerms[row.id].forEach(function (queryTerms, i) {
        var fieldName = fieldBoosts[i].field;
        var text = doc[fieldName];
        // TODO: this is fairly naive highlighting code; could improve
        // the regex
        Object.keys(queryTerms).forEach(function (queryTerm) {
          var regex = new RegExp('(' + queryTerm + '[a-z]*)', 'gi');
          var replacement = pre + '$1' + post;
          text = text.replace(regex, replacement);
          row.highlighting[fieldName] = text;
        });
      });
    });
  })).then(function () {
    return rows;
  });
}

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.plugin(exports);
}
