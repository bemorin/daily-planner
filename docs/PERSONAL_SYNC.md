# Personal sync

> Status: implemented behind deployment configuration. Personal use still works without an account, Google Drive, or a network connection.

Daily Planner treats Personal sync as an optional transport around the local planner rather than as the source of truth for using the app.

## What is synchronized

The first protocol deliberately uses stable top-level records instead of one opaque browser dump:

```text
settings
day:2026-08-16
day:2026-08-17
...
```

A day remains the first merge boundary. Tasks, outcomes, notes, and schedule blocks already have stable IDs inside that day, which leaves room for finer-grained merges later without requiring the first transport to understand every UI feature.

Each synced record carries a content hash plus deletion metadata. Local sync metadata keeps the hash that was last confirmed on both sides.

## Conflict rule

For each record the client compares:

```text
last confirmed hash
current local hash
current remote hash
```

That gives four useful cases:

```text
only local changed     → push local
only remote changed    → pull remote
both changed identically → mark synced
both changed differently → stop and ask
```

The last case is intentionally conservative. The app does not silently choose a winner when the same record changed independently on two devices.

## Deletions are tombstones

Removing a planner record is also a state change. The local sync ledger records a tombstone instead of forgetting that the record existed. The tombstone can then propagate to another device so deleted data does not reappear simply because the other device still had an older copy.

## Google Drive transport

Google Drive sync uses the non-sensitive `drive.appdata` OAuth scope and one hidden file in the user's `appDataFolder`:

```text
Google Drive appDataFolder
└── daily-planner-sync.json
```

The file represents the current Personal sync state. It is not used as a remote version-history or backup archive.

The browser calls the Drive API directly. Personal planner data therefore does not need to pass through Daily Planner Cloud.

## Startup sync

After a user explicitly connects Google Drive, the app remembers that sync is enabled on that device.

Automatic sync — including startup, idle batching, focus/visibility, online, hide, and Close day — runs **only while a usable in-memory Google access token already exists**. Those paths never call Google Identity Services `requestAccessToken()`, so they cannot open OAuth popups, account choosers, or consent windows in the background.

If the access token is missing or expired, the planner stays fully local, keeps dirty state, and shows a quiet **Reconnect Google Drive** action. Only that explicit user gesture (or the first **Connect Google Drive**) may invoke interactive Google authorization.

## Opportunistic sync

Local edits always write to `localStorage` immediately. Google Drive is not updated on every keystroke.

When sync is connected and local records are dirty, the client batches uploads **when a usable access token is already available**:

- idle wait of about 50 seconds after the latest change;
- maximum wait of about 2 minutes from the first dirty change, even if editing continues;
- checks when the app starts, becomes visible/focused again, or regains network;
- a best-effort attempt when the app becomes hidden;
- a sync attempt after Close day.

If no usable token is available, those triggers do nothing interactive: local edits continue, dirty state remains, and the UI asks the user to reconnect.

**Sync now** uses the current in-memory token only. **Reconnect Google Drive** is the explicit control that may open Google authorization. There is no continuous polling and no backend.

## Recovery snapshots

Before remote changes are applied, Daily Planner attempts to write a local recovery snapshot to IndexedDB. At most five snapshots are retained.

These snapshots are a guard against a bad merge or accidental remote change. They are not a substitute for the explicit portable JSON backup, and they stay on the device.

## Deployment setup

1. Create or select a Google Cloud project.
2. Enable the Google Drive API.
3. Configure the OAuth consent screen.
4. Create an OAuth 2.0 Web client.
5. Add the planner's production origin as an authorized JavaScript origin. Add the localhost origin used for development if you want to test OAuth locally.
6. Build the planner with the public client ID:

```bash
DAILY_PLANNER_GOOGLE_CLIENT_ID="...apps.googleusercontent.com" npm run build
```

The client ID is public configuration, not a secret. Do not add client secrets to the browser application.

When `DAILY_PLANNER_GOOGLE_CLIENT_ID` is blank, the Personal sync section is not rendered and no Google request is made.

## What this does not do yet

- field-level merge inside one day;
- continuous background sync after the browser is closed;
- Google Calendar event integration;
- OneDrive or iCloud adapters;
- remote backup history in Google Drive.

Those are separate concerns and should not be added by weakening the local-first boundary or the conflict policy.
