# Optional cloud service boundary

> Status: client boundary in progress. The public planner remains local-first; the server implementation lives in a separate private repository.

Daily Planner should remain a complete local-first planner. Cloud functionality, if offered, is an optional service around that local product rather than a requirement for using Day, Week, Horizon, Journal, Unresolved, or local backups.

## Repository boundary

```text
daily-planner/                 public, source-available
├─ local planner runtime
├─ local persistence
├─ offline/PWA behavior
├─ import/export
├─ optional workspace client boundary
├─ personal sync protocol
├─ Google Drive personal sync adapter
└─ UI for optional account / company workspace

daily-planner-cloud/           private
├─ authentication
├─ organization sync API
├─ team conflict resolution
├─ organization backups
├─ billing / entitlements
├─ email / account operations
├─ calendar integrations
└─ deployment / monitoring
```

The private service should not be implemented as secret JavaScript injected into the public client. Code shipped to a browser is inspectable. The durable Enterprise boundary is an API: the public client knows how to request organization data, while the private service owns accounts, organization persistence, operations, and billing. Personal sync is a different path: the public client can synchronize directly with the user's own cloud storage without sending Personal planner data through Daily Planner Cloud.


## Workspace boundary

The public client may be built with a `CLOUD_API_URL`. When that value is blank, no workspace request is made and the application behaves exactly like the local-only planner. When an authenticated cloud profile eventually returns organizations, the client can expose **Personal** plus those organization workspaces.

Selecting an organization must never reinterpret the Personal planner as company data. Personal Day, Journal, Horizon, habits, and local notes stay private. Shared calendars, mentions, categories, and future booking surfaces belong to the organization workspace and are loaded through explicit organization-scoped API calls.

## Product principles

1. **Local first.** Creating an account must never be required to use the core planner.
2. **Offline capable.** Losing a network connection must not stop planning or editing local data.
3. **Explicit sync state.** The UI should distinguish local state, pending changes, and confirmed remote state.
4. **Stable identifiers.** Synced entities need durable IDs rather than relying only on dates or array positions.
5. **Deletion is data.** A sync protocol needs tombstones/version metadata so deletions do not silently reappear on another device.
6. **Conflicts are expected.** Concurrent edits across devices must have a defined merge or conflict policy.
7. **The server is not the UI.** Business-critical server behavior stays behind the API; presentation stays in the public client.
8. **Export remains available.** Paid cloud services must not make user data hostage to the service.

## Likely paid service value

An official hosted Enterprise service could eventually provide:

- organization and team synchronization;
- centrally managed backups;
- restore/history;
- account recovery;
- calendar integrations;
- operational monitoring and reliability;
- future collaboration or automation services where they fit the product.

Those are service and infrastructure benefits. The local planner should not be intentionally degraded to manufacture an upgrade reason.

## Before implementation

The Personal sync path starts with a sync-safe local data model and protocol:

- stable entity IDs;
- revision/version metadata;
- mutation timestamps or logical clocks;
- deletion/tombstone semantics;
- an API payload format;
- conflict resolution rules;
- migration/versioning strategy.

Only after that contract is tested should a cloud backend be built.
