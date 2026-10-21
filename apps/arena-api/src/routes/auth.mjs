import { registerAuthor } from "../auth/registration.mjs";

/** Registration HTTP adapter. Response/parser helpers are supplied by dispatcher. */
export async function handleRegistration(req, res, context) {
  const { db, publicRegistration, maxBodyBytes, parseJsonBody, sendError, sendJson } = context;
  if (!publicRegistration) {
    return sendError(res, 404, "REGISTRATION_DISABLED", "Public registration is disabled", {}, req);
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "Use POST to register", {}, req);
  }
  const mediaType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json", {}, req);
  }
  let payload;
  try {
    payload = await parseJsonBody(req, Math.min(8192, maxBodyBytes));
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.code || "BAD_REQUEST", error.message, {}, req);
  }
  try {
    const user = registerAuthor(db, payload);
    return sendJson(res, 201, { user });
  } catch (error) {
    if (["INVALID_PAYLOAD", "VALIDATION_ERROR", "USERNAME_TAKEN"].includes(error.code)) {
      return sendError(res, error.statusCode, error.code, error.message, {}, req);
    }
    throw error;
  }
}
