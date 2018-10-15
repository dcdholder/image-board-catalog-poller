//fire off request for a board list and a request for matching data at the same time
//create an object keyed first by board, then by search term, pointing to a label
//for each board in the above object, call the api and request the catalog for that board
//once the catalogs have been retrieved, search them for the search terms and create a result object for every match
//create an object with the labels as keys and an array of the result objects as objects
//remove duplicates on a per-label, per-thread basis (threads meeting multiple search terms)
//iterate through result objects and overwrite the cache with the relevant information
const request = require('request-promise-native');

const config   = require("./config.json");

var db = {};

function findThreadsNotifySubscribers() {
  //variables shared between promises without making dummy promises
  let searchDoc;

  let boardTermLabel;
  let relevantBoards;
  let linkByLabel;

  let globalDiffedResultsByWebhook;

  //query DB for search doc and query API for board list concurrently
  let searchDocPromise = getSearchDoc();
  let boardListPromise = getBoardList();

  return Promise.all([searchDocPromise,boardListPromise]).then((values) => {
    searchDoc = values[0];
    boardList = values[1];

    boardTermLabel = mapBoardTermLabel(searchDoc,boardList);
    relevantBoards = Object.keys(boardTermLabel);

    //construct the catalog request promises
    let boardCatalogPromises = [];
    for (board of relevantBoards) {
      boardCatalogPromises.push(getBoardCatalog(board));
    }

    //request all catalogs concurrently
    return Promise.all(boardCatalogPromises);
  }).then((values) => {
    //construct the board/catalog mapping
    let catalogs = {};
    for (let i=0;i<relevantBoards.length;i++) {
      catalogs[relevantBoards[i]] = values[i];
    }

    //for each board, search for each term which applies to that board
    let searchResults = {};
    for (let board in catalogs) {
      searchResults[board] = searchCatalog(catalogs[board],boardTermLabel[board],board);
    }

    //for each label, collect all search results which match the label
    let searchResultsByLabel = {};
    for (let board in searchResults) {
      for (let result of searchResults[board]) {
        let label = result.label;
        if (!(label in searchResultsByLabel)) {
          searchResultsByLabel[label] = [];
        }
        searchResultsByLabel[label].push(result);
      }
    }

    //collect links by label
    linkByLabel = {};
    for (let label in searchResultsByLabel) {
      linkByLabel[label] = [];
      for (let searchResult of searchResultsByLabel[label]) {
        linkByLabel[label].push(searchResult.link);
      }
    }

    //collect results by webhook
    let resultsByWebhook = getResultsByWebhook(searchDoc,searchResultsByLabel); //TODO: may be duplicates if multiple labels get same results

    return diffResultsByWebhook(resultsByWebhook,linkByLabel);
  }).then((diffedResultsByWebhook) => {
    globalDiffedResultsByWebhook = diffedResultsByWebhook; //ugly as sin!

    //send out the results to webhooks (buffered by SQS and another dedicated function)
    //cache all links represented by results you sent out so only diffs are sent next time
    let notifySubscribersPromise = notifySubscribers(diffedResultsByWebhook);
    let cacheLinksPromise        = cacheLinks(linkByLabel);

    return Promise.all([notifySubscribersPromise,cacheLinksPromise]);
  }).then(() => {
    console.log(globalDiffedResultsByWebhook);
    //console.log(JSON.stringify(globalDiffedResultsByWebhook));
  });
}

//map labels by board, then by search term
function mapBoardTermLabel(searchDoc,boardList) {
  let boardTermLabel = {};
  for (let label in searchDoc) {
    for (let board of searchDoc[label].boards) {
      if (boardList.indexOf(board)!==-1) {
        if (!boardTermLabel[board]) { //add board key if not present
          boardTermLabel[board] = {};
        }
        for (let term of searchDoc[label].terms) {
          if (!boardTermLabel[board][term]) { //add term key if not present for that board
            boardTermLabel[board][term] = [];
          }
          boardTermLabel[board][term].push(label);
        }
      }
    }
  }

  return boardTermLabel;
}

function getResultsByWebhook(searchDoc,searchResultsByLabel) {
  let resultsByWebhook = {};
  for (let label in searchResultsByLabel) {
    for (let webhook of searchDoc[label].subscribers) {
      if (!(webhook in resultsByWebhook)) {
        resultsByWebhook[webhook] = [];
      }
      resultsByWebhook[webhook].push(...searchResultsByLabel[label]);
    }
  }

  return resultsByWebhook;
}

//TODO: real implementation
function getSearchDoc() {
  let searchDoc = require("./searchdoc.json");

  return Promise.resolve(searchDoc);
}

/*
//TODO: real implementation
function getBoardList() {
  let boards = require("./boards.json");

  return Promise.resolve(boards);
}
*/

function getBoardList() {
  return request({
    "method": "GET",
    "uri": config.api + "/boards.json",
    "json": true
  }).then((response) => {
    let boards = [];

    for (let boardEntry of response.boards) {
      boards.push(boardEntry.board);
    }

    console.log(boards);
    return Promise.resolve(boards);
  }).catch((err) => {
    console.log(err);
  });
}

/*
//TODO: real implementation
function getBoardCatalog(board) {
  let catalog = require("./catalog.json");

  return Promise.resolve(catalog);
}
*/

function getBoardCatalog(board) {
  return request({
    "method": "GET",
    "uri": config.api + "/" + board + "/catalog.json",
    "json": true
  }).then((response) => {
    console.log(response);
    return Promise.resolve(response);
  }).catch((err) => {
    console.log(err);
  });
}

function diffResultsByWebhook(resultsByWebhook,linkByLabel) {
  return identifyNewLinks(linkByLabel).then((newLinks) => {
    let diffedResultsByWebhook = {};

    for (let webhook in resultsByWebhook) {
      diffedResultsByWebhook[webhook] = diffResultsUsingNewLinks(resultsByWebhook[webhook],newLinks);
    }

    return Promise.resolve(diffedResultsByWebhook);
  });
}

//TODO: real implementation
function identifyNewLinks(linkByLabel) {
  let newLinks = {};
  for (let label in linkByLabel) {
    newLinks[label] = [];
    if (db.linksCache && db.linksCache[label]) { //check if there even IS a linksCache first
      for (let link of linkByLabel[label]) {
        if (db.linksCache[label].indexOf(link)===-1) {
          newLinks[label].push(link);
        }
      }
    } else {
      newLinks[label] = linkByLabel[label];
    }
  }

  return Promise.resolve(newLinks);
}

function diffResultsUsingNewLinks(results,newLinks) {
  let diffedResults = [];
  for (let result of results) {
    if (newLinks[result.label].indexOf(result.link)!==-1) {
      diffedResults.push(result);
    }
  }

  return diffedResults;
}

function searchCatalog(catalog,labelsByTerm,board) {
  let pages = catalog;

  //collect thread subjects and op comments
  let threadData = {};
  for (let pageContents of pages) {
    let pageThreads = pageContents.threads;
    for (let pageThread of pageThreads) {
      let thread = pageThread.no;

      threadData[thread] = {};

      if (pageThread.sub) {threadData[thread].sub = pageThread.sub;}
      if (pageThread.com) {threadData[thread].com = pageThread.com;}
    }
  }

  //put all titles and op comments through the search term matcher
  let results = [];
  for (let thread in threadData) {
    let matchedSearchTerms = [];
    for (let field in threadData[thread]) {
      for (let term in labelsByTerm) {
        if (matchSearchTerm(threadData[thread][field],term)) {
          matchedSearchTerms.push(term);
        }
      }
    }

    //invert the term => labels mapping to get a label => terms mapping
    let termsByLabel = {};
    for (let matchedSearchTerm of matchedSearchTerms) {
      for (let label of labelsByTerm[matchedSearchTerm]) {
        if (!(termsByLabel[label])) {
          termsByLabel[label] = [];
        }
        termsByLabel[label].push(matchedSearchTerm);
      }
    }

    //now for each label/thread combination, append a result object to results
    for (let label in termsByLabel) {
      let result = {
        label: label,
        terms: termsByLabel[label],

        board: board,
        no:    thread,
        link:  `${config.site}/${board}/thread/${thread}`
      };

      if (threadData[thread].sub) {result.subject = threadData[thread].sub;}
      if (threadData[thread].com) {result.op      = threadData[thread].com;}

      results.push(result);
    }
  }

  return results;
}

function matchSearchTerm(text,searchTerm) {
  var re = new RegExp(searchTerm);

  return re.test(text);
}

//TODO: real implementation
function cacheLinks(linkByLabel) {
  db.linksCache = linkByLabel;

  return Promise.resolve();
}

//TODO: real implementation
function notifySubscribers(resultsByWebhook) { //do nothing for now
  return Promise.resolve();
}

findThreadsNotifySubscribers();
