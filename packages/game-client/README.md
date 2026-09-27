# `@ottv2/game-client`

Browser-facing connection and PlayHTML adapter code. It exposes the client
API without allowing UI components to depend on transport internals.

The canonical sources are:

- `src/playhtml-bootstrap.js`
- `src/playhtml-game-client.js`

Both files keep the existing single PlayHTML connection and authoritative
Worker state boundary.
