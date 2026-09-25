function connectionAdapter(connection) {
  if (!connection || typeof connection.send !== "function") throw new TypeError("Invalid connection");
  return {
    id: String(connection.id || ""),
    readyState: connection.readyState === undefined ? 1 : connection.readyState,
    send(message) {
      if (this.readyState !== 1) return;
      connection.send(typeof message === "string" ? message : JSON.stringify(message));
    }
  };
}

const adaptConnection = connectionAdapter;

module.exports = { connectionAdapter, adaptConnection };
