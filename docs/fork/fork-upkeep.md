# Fork plan: manual updates and data safety

Status: **approved concept, not yet implemented** (decided 2026-10-27). Fork-only document (`XXios/learnharness`). Changes decision D7 of `claude-code-subscription.md`: there is no update feed for fork builds.

## Facts

- All user data lives in `~/Library/Application Support/LearnHarness/` (`data/`, `auth.json`, subscription connection files; `electron/main.cjs:56`), never inside `LearnHarness.app`. Replacing the app never touches it.
- The folder is derived from the app name and `appId` (`com.learnharness.LearnHarness`). **Never change either one**, or the app starts empty.
- In-app updates of fork builds are not viable: `XXios/learnharness` has no releases ("No published versions on GitHub"), and ad-hoc signed builds fail macOS's same-signature update check.

## Approved decisions

| # | Decision |
|---|---|
| U1 | **Manual updates:** merge upstream releases into the fork by hand (keeping the fork's features), build locally (`desktop:dist`), replace `/Applications/LearnHarness.app`. Publishing signed fork releases might come later (needs an Apple Developer ID). |
| U2 | **Backup when the version changes:** on startup, if the app version differs from the one recorded at the last run, copy `data/` to `backups/<old-version>-<date>/` in userData **before the server starts**. Keep the last 3. |
| U3 | **Hide the updater in fork builds:** no automatic check, no "Check for updates" button. Settings › General shows the version plus "Fork build — updated manually." |

**Process rule (AGENTS.md):** any open implementation question → ask the user first.
