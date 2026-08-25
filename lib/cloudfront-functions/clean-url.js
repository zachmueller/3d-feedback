// CloudFront viewer-request function for the DEFAULT behavior (share URLs).
//
// Attach this ONLY to the default behavior. It must never run on /login,
// /admin, /app/*, /viewer/*, /projects/*, /comments/* or /status/*, which have
// their own behaviors and real keys.
//
// Cascade:
//   1. "/"                    -> 302 redirect to /login (admin entry; there is
//                                no public catalog).
//   2. lowercase the first path segment (the project slug) so a share link that
//      picked up capitalization still resolves.
//   3. last segment has a "." -> concrete asset, pass through. (Models are
//      served by the *.glb behavior and never reach this function; this covers
//      stray requests like /favicon.ico.)
//   4. /<slug>, /<slug>/, /<slug>/<rev>, /<slug>/<rev>/  ->  internal rewrite to
//      /viewer/index.html. One viewer SPA serves every project and revision; it
//      reads the project + revision back out of location.pathname, so the shared
//      URL is preserved exactly as sent (no redirect to a trailing slash).
//   5. anything else          -> pass through; a missing key becomes the 404 page.
//
// Written in ES5 style for the CloudFront Functions runtime.
var VIEWER = '/viewer/index.html';

function isRevision(segment) {
  if (!segment || segment.length > 9) return false;
  for (var i = 0; i < segment.length; i++) {
    var c = segment.charAt(i);
    if (c < '0' || c > '9') return false;
  }
  return true;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // 1. Root goes to the admin login page.
  if (uri === '/' || uri === '') {
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: { location: { value: '/login' } },
    };
  }

  // 2. Lowercase the first path segment (the slug). uri begins with '/', so
  //    parts[0] is always the empty string and parts[1] is the slug.
  var parts = uri.split('/');
  if (parts.length > 1 && parts[1]) {
    parts[1] = parts[1].toLowerCase();
    uri = parts.join('/');
  }

  // 3. A file extension in the last segment means a real object was requested.
  var lastSegment = parts[parts.length - 1];
  if (lastSegment.indexOf('.') !== -1) {
    request.uri = uri;
    return request;
  }

  // 4. Share URL shapes, all served by the viewer SPA:
  //      /<slug>              parts = ['', slug]
  //      /<slug>/             parts = ['', slug, '']
  //      /<slug>/<rev>        parts = ['', slug, rev]
  //      /<slug>/<rev>/       parts = ['', slug, rev, '']
  if (parts.length === 2 && parts[1]) {
    request.uri = VIEWER;
    return request;
  }
  if (parts.length === 3 && parts[1] && (parts[2] === '' || isRevision(parts[2]))) {
    request.uri = VIEWER;
    return request;
  }
  if (parts.length === 4 && parts[1] && isRevision(parts[2]) && parts[3] === '') {
    request.uri = VIEWER;
    return request;
  }

  // 5. Anything else: let the origin answer (missing keys become the 404 page).
  request.uri = uri;
  return request;
}
