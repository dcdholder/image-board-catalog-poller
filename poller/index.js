//fire off request for a board list and a request for matching data at the same time
//create an object keyed first by board, then by search term, pointing to a label
//for each board in the above object, call the api and request the catalog for that board
//once the catalogs have been retrieved, search them for the search terms and create a result object for every match
//create an object with the labels as keys and an array of the result objects as objects
//remove duplicates on a per-label, per-thread basis (threads meeting multiple search terms)
//iterate through result objects and overwrite the cache with the relevant information

//variables shared between promises without making dummy promises
let searchDoc;
let boardList;

let boardTermLabel;
let boards;
let linkByLabel;
let resultsByWebhook;

//query DB for search doc and query API for board list concurrently
let searchDocPromise = getSearchDoc();
let boardListPromise = getBoardList();

return Promise.all([searchDocPromise,boardListPromise]).then((values) => {
  searchDoc = values[0];
  boardList = values[1];

  //map labels by board, then by search term
  boardTermLabel = {};
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

  //construct the catalog request promises
  let boardCatalogPromises = [];
  for (board of boardList) {
    boardCatalogPromises.push(getBoardCatalog(board));
  }

  //request all catalogs concurrently
  return Promise.all(boardCatalogPromises);
}).then((values) => {
  //construct the board/catalog mapping
  let catalogs = {};
  for (let i=0;i<boardList.length;i++) {
    catalogs[boards[i]] = values[i];
  }

  //for each board, search for each term which applies to that board
  let searchResults = {};
  for (let board in catalogs) {
    searchResults[board] = searchCatalog(catalogs[board],boardTermLabel[board]);
  }

  //for each label, collect all search results which match the label
  let searchResultsByLabel = {};
  for (let board in searchResults) {
    let result = searchResults[board][i];
    let label  = result.label;
    if (!(label in searchResultsByLabel)) {
      searchResultsByLabel[label] = [];
    }
    searchResultsByLabel[label].push(result);
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
  //TODO: may be duplicates if multiple labels get same results
  resultsByWebhook = {};
  for (let label in searchResultsByLabel) {
    for (let webhook of searchDoc[label].webhooks) {
      if (!(webhook in resultsByWebhook)) {
        resultsByWebhook[webhook] = [];
      }
      resultsByWebhook[webhook].push(...searchResultsByLabel[label]);
    }
  }

  return identifyNewLinks(linkByLabel);
}).then(() => {
  //send out the results to webhooks (buffered by SQS and another dedicated function)
  //cache all links represented by results you sent out so only diffs are sent next time
  let notifySubscribersPromise = notifyWebhooks(resultsByWebhook);
  let cacheLinksPromise        = cacheLinks(linkByLabel);

  return Promise.all([notifySubscribersPromise,cacheLinksPromise]);
});

function cacheLinks() {}

function notifyWebhooks() {}

function getSearchDoc() {}

function getBoardList() {}

function identifyNewLinks() {}

function searchCatalog() {}

function getBoardCatalog() {}
