const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_ID_LENGTH = 4;
const PREFIX = "waiting-room:";

function sanitizeName(name) {
  const value = String(name || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (value || "Khách").slice(0, 24);
}

function publicRecord(record) {
  return {
    id: record.id,
    players: record.players,
    names: {
      ...(record.names?.A ? { A: sanitizeName(record.names.A) } : {}),
      ...(record.names?.B ? { B: sanitizeName(record.names.B) } : {})
    }
  };
}

class WaitingRoomRegistry {
  constructor(storage, { random = Math.random, publish = null } = {}) {
    if (!storage || typeof storage.list !== "function" || typeof storage.put !== "function") {
      throw new TypeError("WaitingRoomRegistry requires durable storage");
    }
    this.storage = storage;
    this.random = random;
    this.publish = publish;
  }

  async create({ id, names = {}, players = 1 } = {}) {
    const roomId = id || await this.#uniqueId();
    const record = {
      id: roomId,
      status: "waiting",
      players,
      names: {
        ...(names.A ? { A: sanitizeName(names.A) } : {}),
        ...(names.B ? { B: sanitizeName(names.B) } : {})
      }
    };
    await this.storage.put(PREFIX + roomId, record);
    await this.#publish();
    return publicRecord(record);
  }

  async update(id, changes) {
    const current = await this.storage.get(PREFIX + id);
    if (!current) return false;
    const next = {
      ...current,
      ...changes,
      id,
      names: {
        ...(changes.names || current.names),
      }
    };
    await this.storage.put(PREFIX + id, next);
    await this.#publish();
    return true;
  }

  async get(id) {
    return this.storage.get(PREFIX + id);
  }

  async remove(id) {
    if (!(await this.storage.get(PREFIX + id))) return false;
    await this.storage.delete(PREFIX + id);
    await this.#publish();
    return true;
  }

  async list() {
    const records = await this.storage.list({ prefix: PREFIX });
    return [...records.values()]
      .filter((record) => record.status === "waiting")
      .map(publicRecord);
  }

  async #uniqueId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let id = "";
      for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
        id += ROOM_ID_ALPHABET[Math.floor(this.random() * ROOM_ID_ALPHABET.length)];
      }
      if (!(await this.storage.get(PREFIX + id))) return id;
    }
    throw new Error("Unable to allocate room id");
  }

  async #publish() {
    if (typeof this.publish === "function") await this.publish(await this.list());
  }
}

module.exports = { WaitingRoomRegistry, sanitizeName, ROOM_ID_ALPHABET };
