# Drift build contracts

This file is the source of truth for module boundaries. Every file listed
under "Files you must create" must exist with exactly the exports described.
All functions are async unless noted. All functions throw real `Error`s on
failure — never return fake success.

Shared honesty rules (from the design docs):
- No dead buttons: a visible control either works or it isn't rendered.
- No lorem ipsum, no fake data, no simulated backends.
- Local adapter UI surfaces must say "local device mode" somewhere honest
  (About/Settings/login footnote).
- Helm local mode must be labeled "local mode" in its UI.

---

## 1. Backend adapter layer — `src/lib/backend/`

### `index.js` — must export:
- `BackendKinds = { LOCAL: 'local', SUPABASE: 'supabase', REPLIT: 'replit' }`
- `createBackend(kind)` → adapter object. `'supabase'` without
  `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` must return the local adapter
  with `adapter.note = 'Supabase env vars absent — running in local device mode.'`
  `'replit'` returns the stub. Unknown kind → local adapter.
- Every adapter object has shape `{ kind, note, auth, settings, files, spaces, pins, helm, highscores, notifications }`.
  `note` is a string or null.

### Adapter interface (all adapters implement ALL of these):

```js
auth: {
  // user = { id, email, username, role: 'admin'|'standard', isGuest }
  signUp({ email, password, username }) -> { user }
  signIn({ email, password }) -> { user }
  signOut() -> void
  getUser() -> { user } | null            // sync ok
  onAuthChange(cb) -> unsubscribe         // cb(user|null), sync ok
}
settings: {
  // s = { visual_theme: 'daybreak'|'nightshift', wallpaper: 'paper-grain'|'linen'|'dusk'|'plain',
  //       accent_override: string|null, ai_engine: 'local'|'cloud', icon_positions: {} }
  get() -> s
  update(patch) -> s
}
files: {
  // entry = { name, path, type: 'file'|'folder', size, mime, updatedAt }
  list(path) -> [entry]                   // path like '/Documents'; '/' = root
  read(path) -> { text }                  // text files only; binary -> throw with .code='IS_BINARY'
  write(path, text) -> entry              // creates or overwrites; makes parent folders
  mkdir(path) -> entry
  remove(path) -> void                    // files and folders (recursive)
  rename(oldPath, newPath) -> void
}
spaces: {
  // space = { id, name, icon, wallpaper, accent, sortOrder }
  list() -> [space]                       // sortOrder order; seed Main/Focus/Play for new users
  create(name) -> space                   // max 8 -> throw Error('maximum 8 spaces per user')
  rename(id, name) -> space
  update(id, patch) -> space              // patch: { wallpaper, accent, icon } (name via rename)
  remove(id) -> void                       // moves that space's window states to 'Main' first
  // ws = { appId, x, y, w, h, z, minimized, props }
  getWindowStates(spaceId) -> [ws]
  saveWindowState(spaceId, ws) -> void    // upsert on (spaceId, appId)
  removeWindowState(spaceId, appId) -> void
}
pins: {
  // pin = { id, kind: 'text'|'link'|'file'|'image'|'note', title, body, url,
  //         tags: [string], sourceApp, mime, sizeBytes, storagePath,
  //         createdAt, updatedAt }
  // (file/image pins: `body` holds the file bytes as a data: URL in the local
  //  adapter (≤2MB); in the supabase adapter bytes live in the private
  //  user-files bucket (≤10MB) and `body` is null. Either way, resolve a usable
  //  URL with fileUrl(pin) — never read body directly for file/image kinds.
  //  create/update accept { dataUrl, mime, sizeBytes } for file/image kinds.)
  list({ kind, tag, limit } = {}) -> [pin]        // newest first
  search(query, { kind, tag } = {}) -> [pin]      // ranked; empty query -> list()
  create({ kind, title, body, url, tags, sourceApp, dataUrl, mime, sizeBytes }) -> pin
  update(id, patch) -> pin                       // patch may include dataUrl to replace the file
  remove(id) -> void                              // also deletes the stored file bytes
  fileUrl(pin) -> string                          // usable URL for a file/image pin's bytes
  tags() -> [string]                              // distinct tags, alpha order
}
helm: {
  // thread = { id, title, createdAt, updatedAt }
  // message = { id, role: 'user'|'assistant'|'tool', content, toolCalls, createdAt }
  threads() -> [thread]                           // updatedAt desc
  createThread(title) -> thread
  messages(threadId) -> [message]                 // createdAt asc
  addMessage(threadId, { role, content, toolCalls }) -> message
  removeThread(id) -> void
}
highscores: {
  // { gameId, score, meta, achievedAt }
  list(gameId, limit=10) -> [{ score, meta, achievedAt }]  // score desc
  record(gameId, score, meta={}) -> void
}
notifications: {
  // { id, title, body, read, createdAt }
  list() -> [notif]                               // newest first
  push({ title, body }) -> notif
  markRead(id) -> void
  dismiss(id) -> void                              // real delete
  clearAll() -> void                               // real delete-all
}
```

### Files to create:
- `src/lib/backend/index.js` (interface docs + `createBackend` + `BackendKinds`)
- `src/lib/backend/local.js` — full localStorage implementation.
  - Passwords: real PBKDF2-SHA256 via `crypto.subtle` (≥100k iterations,
    random 16-byte salt). Never store plaintext.
  - Guest: `signInGuest()` (extra, local-only) → ephemeral user
    `{ isGuest: true }`; UI labels it "trial".
  - Storage keys namespaced `drift:<uid>:<collection>`. Files tree stored as
    nested JSON. Binary `read()` throws `{ code: 'IS_BINARY' }`; keep
    `write()` text-only (≤512KB per file, honest error above).
  - Pin search: real token-based ranked search over the user's own pins.
  - First user ever on this device becomes `admin`.
- `src/lib/backend/supabase.js` — implements the interface against the schema
  in `../build3-supabase-schema.md` (tables: profiles, user_settings,
  vfs_folders, vfs_files, spaces, window_states, pins, helm_threads,
  helm_messages, game_highscores, notifications; `search_pins` rpc; storage
  buckets `user-files`, `user-wallpapers`). Guest → real auth user with
  `raw_user_meta_data.is_guest=true` (add `signInGuest()` extra).
  Must import `@supabase/supabase-js` only (dependency is installed).
- `src/lib/backend/replit.js` — stub: every method throws
  `new Error('Replit adapter not wired yet (TODO: Replit Postgres REST).')`.
  `kind='replit'`, `note` explains the stub honestly.

### `src/lib/helm.js` — must export:
- `HELM_TOOLS`: array of `{ name, description, params: [string] }` for:
  `open_app(app_id)`, `close_app(app_id)`, `go_to_space(name_or_index)`,
  `set_theme(name)`, `set_wallpaper(id)`, `create_pin(title, body, tags)`,
  `search_pins(query)`, `list_files(path)`, `read_file(path)`, `get_time()`.
- `runLocalHelm(text, ctx)` → `{ reply, receipts: [{ tool, label, ok }] }`.
  Deterministic command parser (documented patterns: open/close app, go to
  space, dark/light theme, `pin this: ...`, search pins, list/read files,
  time, help). `ctx` provides the real functions:
  `{ openApp, closeApp, goToSpace, setTheme, setWallpaper, createPin,
     searchPins, listFiles, readFile, resolveAppId }`.
  Unknown input → honest "I didn't understand" reply (never invented state).
- `formatToolReceipt(tool, args, result)` → short human label like
  `Opened Files`, `Pinned "groceries"`.

---

## 2. OS shell — contexts in `src/os/`, components in `src/components/os/`

Import the backend singleton: `import { backend } from '../lib/backend/current.js';`
(adjust relative path per file).

### `src/os/AuthContext.jsx` — exports `AuthProvider`, `useAuth()`
`useAuth()` → `{ user, loading, signUp(email,password,username), signIn(email,password), signInGuest(), signOut() }`.
- `loading` true until first `getUser()`/`onAuthChange` settles.
- All errors propagate as thrown Errors (LoginScreen displays them).

### `src/os/SettingsContext.jsx` — exports `SettingsProvider`, `useSettings()`
`useSettings()` → `{ settings, loading, updateSettings(patch), theme }`.
- Applies `document.documentElement.dataset.theme = settings.visual_theme`.
- Applies `accent_override` via `style.setProperty('--os-accent', ...)` (empty → remove).
- `theme` = `settings.visual_theme`.

### `src/os/NotificationsContext.jsx` — exports `NotificationsProvider`, `useNotifications()`
`useNotifications()` → `{ notifications, unreadCount, push(title, body), markRead(id), dismiss(id), clearAll() }`.
- Loads from `backend.notifications` on login; `push` writes through the backend.

### `src/os/WindowsContext.jsx` — exports `WindowsProvider`, `useWindows()`
Window: `{ id, appId, title, x, y, w, h, z, minimized, maximized, props }`.
- `windows` (all spaces), `visibleWindows` (active space only),
  `spaces`, `activeSpaceId`,
  `openWindow(appId, props={})`, `closeWindow(id)`, `focusWindow(id)`,
  `minimizeWindow(id)`, `toggleMaximize(id)`,
  `moveWindow(id, x, y)`, `resizeWindow(id, w, h)`,
  `setActiveSpace(id)`, `createSpace(name)`, `renameSpace(id, name)`, `updateSpace(id, patch)`, `deleteSpace(id)`.
- New windows cascade from (120,90). `z` increments on focus. Minimize keeps
  state (no unmount). Maximize fills the desktop area above the taskbar.
- Layouts persist: debounced 800ms → `backend.spaces.saveWindowState`
  per open window of the active space; on login, restore each space's saved
  windows (open them minimized=false with saved geometry/props).
- App metadata (title, default size, component) comes from
  `../apps/registry.jsx` (`getApp(appId)`). Unknown appId → throw.
- Drag/resize implemented in `Window.jsx` with pointer events; constrain
  within the desktop bounds.

### Components (`src/components/os/`):
- `BootScreen.jsx` — props `{ onDone }`. Real init: `backend` ping
  (`backend.settings.get()`), session restore; shows 2–3 honest status lines
  then calls `onDone()`. Drift wordmark + paper-plane mark (SVG, no emoji).
- `LoginScreen.jsx` — sign in / create account / "try without an account"
  (guest). Real validation + error display. Footnote shows backend mode
  (`backend.note || 'local device mode'`).
- `Desktop.jsx` — wallpaper div (`wallpaper-<id>` class from settings),
  renders `DesktopIcons`, `visibleWindows` via `Window.jsx`, `Taskbar`.
  Handles `Ctrl+1..8` → space switch, `Ctrl+Shift+P` → open Pinboard composer
  (open Pinboard app with `props: { composer: true }`).
- `DesktopIcons.jsx` — icons for openable apps (Files, Pinboard, Spaces,
  Helm, Settings); double-click opens, single-click selects. Games from the
  registry with `comingSoon: true` render as non-clickable tiles labeled
  "coming soon".
- `Window.jsx` — props `{ win }`. Title bar (icon, title, min/max/close —
  all working), drag by title bar, resize from edges/corners, focus on
  pointer down. Renders the app component for `win.appId` with
  `props: win.props` plus a `windowApi: { close, setTitle }`.
- `Taskbar.jsx` — start button (opens `StartMenu`), Spaces rail (dots +
  names, click to switch, ≤8), window buttons (click focus/toggle minimize),
  notification bell with badge → `NotificationsPanel`, clock (real, ticks
  each second), Helm quick toggle.
- `StartMenu.jsx` — search field filters apps for real; app rows open apps;
  coming-soon games shown disabled; footer: user chip + working Sign out.
- `NotificationsPanel.jsx` — list from context; each row: mark-read on open,
  working dismiss (×), working "Clear all". Empty state is honestly empty.

---

## 3. Apps — `src/apps/`

### `src/apps/registry.jsx` — exports `APPS`, `getApp(id)`, `resolveAppId(input)`
- Entry: `{ id, title, icon (lucide component), component, defaultSize: {w,h}, comingSoon?: bool }`.
- Apps: files, pinboard, spaces, helm, settings (+ chess, checkers, klondike
  with `comingSoon: true`, `component: null` — never clickable).
- `resolveAppId(input)`: fuzzy match on id/title for Helm; returns id or null.

### App components (each receives `{ windowApi }` and any `props` passed at open):
- `FilesApp.jsx` — toolbar (new file, new folder, upload-note for text only),
  path breadcrumb (clickable), list (click select, double-click open folder /
  open text file in editor), editor view (textarea + Save/Cancel, dirty guard),
  rename (inline), delete (confirm). All through `backend.files`. Binary files:
  show "binary — not previewable in local mode" honestly.
- `PinboardApp.jsx` — masonry-ish list, kind filter chips (All/Text/Links/
  Files/Images), tag filter, search box (debounced, uses `backend.pins.search`
  — real ranked results), composer (title/body/url/tags by kind; opened with
  `props.composer=true` focuses it), detail edit, delete. `Ctrl+Shift+P`
  anywhere opens it via Desktop.
- `SpacesApp.jsx` — grid of spaces: rename (inline), delete (confirm; windows
  merge to Main via backend), create (≤8 enforced with real error), set
  wallpaper per space (same 4 honest options), click a space to switch.
- `HelmApp.jsx` — thread list + chat pane. Uses `backend.helm` for history
  and `runLocalHelm` from `../lib/helm.js` for answers. Header shows
  `Local mode` badge (or `Cloud` when `settings.ai_engine==='cloud'` AND
  backend is supabase — otherwise local badge; never claim cloud falsely).
  Tool receipts render as chips ("Opened Files"). New thread / delete thread
  (confirm) work.
- `SettingsApp.jsx` — sections: Appearance (theme Daybreak/Nightshift radio
  that applies instantly, accent color choices incl. "default", wallpaper 4
  options with live preview), Helm (engine local/cloud radio; cloud shows
  honest "needs Supabase backend + helm-chat" note when unavailable), Data
  ("Export my data" → downloads real JSON of settings/files/pins/spaces),
  About (backend kind + note, app version, storage used = computed byte
  count from files+pins — real `reduce`, never a constant).

Every button in every app must do something real. When in doubt, omit the control.

---

## 4. Conventions

- Plain JSX, React 18. No TypeScript. No new dependencies (lucide-react and
  @supabase/supabase-js are already installed).
- Tailwind classes use theme tokens: `bg-paper`, `bg-surface`, `text-ink`,
  `text-muted`, `bg-accent`, `text-accentink`, `border-osborder`, `shadow-os`,
  `duration-160`, `rounded-os`.
- Icons: `lucide-react` only. No emoji in UI chrome.
- Errors: `try/catch` at the UI boundary → `useNotifications().push('Error', message)`.
- No `console.log` noise; `console.error` for real failures is fine.
