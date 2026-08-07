// ─────────────────────────── UPLOAD STORAGE ───────────────────────────
// Uploads used to be written to backend/uploads/ and served by
// express.static. That works locally but not on a managed host: Render's
// filesystem is ephemeral, so every restart, redeploy or idle spin-down
// wipes it — files were surviving minutes, not sessions, and every image
// in the app 404'd shortly after being uploaded.
//
// Cloudinary holds the bytes instead. What's stored in Postgres is still
// just a URL string, so every existing `url`/`snapshot_url` column and
// every consumer of them keeps working unchanged — the values are simply
// absolute `https://res.cloudinary.com/...` URLs now instead of relative
// `/uploads/...` paths. The frontend already prefixes relative paths with
// API_ORIGIN and leaves absolute ones alone, so nothing there needed to
// change either.
const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ← Lets routes fail loudly and early with a clear message rather than
//   getting an opaque 401 from Cloudinary on the first upload attempt.
const CLOUDINARY_CONFIGURED = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

// Folders mirror the old on-disk layout so the Cloudinary media library
// stays browsable in the same shape people already know.
const FOLDERS = {
  photos:            "atoproof/photos",
  jobPhotos:         "atoproof/job-photos",
  branding:          "atoproof/branding",
  geometrySnapshots: "atoproof/geometry-snapshots",
  originalPhotos:    "atoproof/original-photos",
};

// `resource_type: "image"` is deliberate over "auto": these endpoints all
// enforce an image MIME allowlist upstream, so anything else arriving here
// is a bug worth surfacing rather than silently storing.
function uploadBuffer(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: "image", overwrite: true },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

// Data-URL variant, for the geometry snapshots the measurement tool posts
// as base64 inside its JSON body rather than as multipart.
async function uploadDataUrl(dataUrl, folder, publicId) {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) return null;
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  return uploadBuffer(Buffer.from(match[2], "base64"), folder, publicId);
}

// Best-effort cleanup when a record is deleted. Never throws: losing the
// remote file is not a reason to fail the delete, exactly as the old
// fs.unlink(..., () => {}) callback ignored its error.
async function destroyByUrl(url) {
  try {
    if (!url || !url.includes("res.cloudinary.com")) return;
    const m = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
    if (m) await cloudinary.uploader.destroy(m[1]);
  } catch { /* ignore — the DB row is already gone */ }
}

module.exports = { cloudinary, CLOUDINARY_CONFIGURED, FOLDERS, uploadBuffer, uploadDataUrl, destroyByUrl };
