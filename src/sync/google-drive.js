const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SYNC_FILE_NAME = 'daily-planner-sync.json';

let gisPromise = null;

function loadGoogleIdentityScript(documentRef = document) {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const existing = documentRef.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Identity Services failed to load.')), { once: true });
      return;
    }
    const script = documentRef.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error('Google Identity Services failed to load.')), { once: true });
    documentRef.head.append(script);
  });
  return gisPromise;
}

async function parseJson(response) {
  if (!response.ok) {
    let message = `Google Drive request failed (${response.status}).`;
    try {
      const body = await response.json();
      message = body?.error?.message || message;
    } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function createGoogleDriveProvider({ clientId, fetchImpl = fetch, documentRef = document } = {}) {
  const cleanClientId = String(clientId || '').trim();
  let token = null;
  let tokenExpiresAt = 0;

  const tokenValid = () => !!token && Date.now() < tokenExpiresAt - 30_000;

  async function ensureToken({ interactive = false } = {}) {
    if (tokenValid()) return token;
    if (!cleanClientId) throw new Error('Google Drive sync is not configured for this deployment.');
    await loadGoogleIdentityScript(documentRef);
    return new Promise((resolve, reject) => {
      const callback = response => {
        if (response?.error || !response?.access_token) {
          reject(new Error(response?.error_description || response?.error || 'Google authorization was not completed.'));
          return;
        }
        token = response.access_token;
        tokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in) || 0) * 1000;
        resolve(token);
      };
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cleanClientId,
        scope: DRIVE_SCOPE,
        callback,
        error_callback: event => reject(new Error(event?.type || 'Google authorization failed.'))
      });
      tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    });
  }

  async function authorizedFetch(url, options = {}) {
    const accessToken = await ensureToken({ interactive: false });
    return fetchImpl(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }
    });
  }

  async function findFile() {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name='${SYNC_FILE_NAME}'`,
      fields: 'files(id,name,modifiedTime,size)',
      pageSize: '10'
    });
    const response = await authorizedFetch(`${DRIVE_FILES}?${params}`);
    const body = await parseJson(response);
    return body.files?.[0] || null;
  }

  async function read() {
    const file = await findFile();
    if (!file?.id) return { exists: false, fileId: '', document: null };
    const response = await authorizedFetch(`${DRIVE_FILES}/${encodeURIComponent(file.id)}?alt=media`);
    if (!response.ok) await parseJson(response);
    const document = await response.json();
    return { exists: true, fileId: file.id, document, modifiedTime: file.modifiedTime || '' };
  }

  async function createFile() {
    const response = await authorizedFetch(`${DRIVE_FILES}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SYNC_FILE_NAME, parents: ['appDataFolder'] })
    });
    const body = await parseJson(response);
    if (!body.id) throw new Error('Google Drive did not return a sync file id.');
    return body.id;
  }

  async function write(documentValue, { fileId = '' } = {}) {
    const id = fileId || (await findFile())?.id || await createFile();
    const accessToken = await ensureToken({ interactive: false });
    const response = await fetchImpl(`${DRIVE_UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime,size`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(documentValue)
    });
    return parseJson(response);
  }

  async function authorize({ interactive = true } = {}) {
    await ensureToken({ interactive });
    return true;
  }

  function clearToken() {
    token = null;
    tokenExpiresAt = 0;
  }

  return { authorize, clearToken, read, write, scope: DRIVE_SCOPE, configured: !!cleanClientId };
}
