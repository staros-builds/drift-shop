/**
 * Raw Supabase Storage upload over XMLHttpRequest.
 *
 * The Supabase JS client's own upload() is fetch-based and exposes no
 * progress events. This helper sends the exact same request the client
 * would for a Blob body — POST to
 *   {url}/storage/v1/object/{bucket}/{path}
 * with the blob inside FormData (field name ''), an `x-upsert` header,
 * and the user's JWT + anon key — but over XHR so callers get REAL
 * byte-level progress via xhr.upload.onprogress.
 *
 * @param {object} args
 * @param {string} args.url        Supabase project URL (https://<ref>.supabase.co)
 * @param {string} args.apiKey     Supabase anon key (sent as the `apikey` header)
 * @param {() => Promise<string>} args.getToken  Resolves the caller's access token (JWT)
 * @param {string} args.bucket     Storage bucket name
 * @param {string} args.storagePath Object path inside the bucket
 * @param {Blob} args.blob         File bytes
 * @param {boolean} [args.upsert]  Passed through as the x-upsert header
 * @param {(sent:number,total:number) => void} [args.onProgress]  Real byte progress
 * @returns {Promise<void>} Resolves on HTTP 2xx, rejects with the server's message otherwise
 */
export async function storageUploadXhr({
  url,
  apiKey,
  getToken,
  bucket,
  storagePath,
  blob,
  upsert = false,
  onProgress = null,
}) {
  const token = await getToken();
  if (!token) throw new Error('Your sign-in expired — sign out and back in, then try again.');
  const encoded = String(storagePath)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const endpoint = `${url}/storage/v1/object/${bucket}/${encoded}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.setRequestHeader('apikey', apiKey);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-upsert', String(!!upsert));
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          try {
            onProgress(e.loaded, e.total);
          } catch {
            /* progress is UI-only; never break the upload */
          }
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          onProgress?.(1, 1);
        } catch {
          /* UI-only */
        }
        resolve();
        return;
      }
      let msg = `server returned ${xhr.status}`;
      try {
        const j = JSON.parse(xhr.responseText);
        if (j?.message) msg = j.message;
        else if (j?.error) msg = j.error;
      } catch {
        /* keep default */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('network error — check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('timed out — try again.'));
    // Mirror the client's own Blob handling: multipart form, blob in the
    // '' field, cacheControl alongside it.
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', blob);
    try {
      xhr.send(form);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('could not start the upload.'));
    }
  });
}
