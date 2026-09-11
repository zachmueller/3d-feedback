// CloudFront viewer-request function for the signed-in page behaviors:
//   /login  /admin  /browse
//
// Maps the clean paths to the static HTML keys stored under app/ in the assets
// bucket, e.g. /admin -> /app/admin.html. A trailing slash is tolerated. Anything
// unexpected falls through to the login page.
//
// This is deliberately separate from clean-url.js: these paths must not be
// lowercased or rewritten to the viewer.
//
// Written in ES5 style for the CloudFront Functions runtime.
var PAGES = {
  '/admin': '/app/admin.html',
  '/browse': '/app/browse.html',
};

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Normalize a single trailing slash ("/admin/" -> "/admin").
  if (uri.length > 1 && uri.charAt(uri.length - 1) === '/') {
    uri = uri.substring(0, uri.length - 1);
  }

  // Own property only: a path like /constructor must not resolve to something
  // inherited from Object.prototype.
  request.uri = PAGES.hasOwnProperty(uri) ? PAGES[uri] : '/app/login.html';

  return request;
}
