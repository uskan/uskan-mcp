# uskan-mcp

[![npm](https://img.shields.io/npm/v/uskan-mcp)](https://www.npmjs.com/package/uskan-mcp) [![CI](https://github.com/uskan/uskan-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/uskan/uskan-mcp/actions/workflows/ci.yml)

Publish your mobile app to the **App Store** and **Google Play** without leaving your editor.

`uskan-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that plugs
[uskan.app](https://uskan.app) into your coding agent — Claude Code, Cursor, Codex CLI or
Claude Desktop. Because the agent is already sitting in your project folder, it reads
`app.json`, `pubspec.yaml`, `build.gradle`, `package.json` and your README, and fills in
everything the uskan website would otherwise ask you to type into a form.

You say:

> publish this app to Google Play with uskan

and the agent detects the package id and stack, creates the uskan project, uploads your
`.aab`, writes localized store copy for every locale in your `i18n/` folder, drafts the
Play Data-safety and content-rating questionnaires, and pushes the build to the internal
track — pausing for your approval on the parts that need a human.

---

## Install

Nothing to install globally — every config below runs it with `npx`, which fetches the
latest version on demand.

**Requirements:** Node.js 18 or newer, and a uskan.app account.

### 1. Get an API token

Create a personal API token at <https://uskan.app/dashboard>. It looks like `usk_live_…`.
Treat it like a password: it can spend your credits and submit apps to the stores.

### 2. Point your agent at the server

#### Claude Code

One command, user scope (available in every project):

```bash
claude mcp add uskan --scope user --env USKAN_API_KEY=usk_live_xxx -- npx -y uskan-mcp
```

Or commit a project-scoped `.mcp.json` in your repo root and keep the token in your shell
environment (`export USKAN_API_KEY=usk_live_xxx`) so it never lands in git:

```json
{
  "mcpServers": {
    "uskan": {
      "command": "npx",
      "args": ["-y", "uskan-mcp"],
      "env": {
        "USKAN_API_KEY": "${USKAN_API_KEY}"
      }
    }
  }
}
```

Verify with `/mcp` inside Claude Code — you should see `uskan` connected with 7 tools.

#### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (this project only):

```json
{
  "mcpServers": {
    "uskan": {
      "command": "npx",
      "args": ["-y", "uskan-mcp"],
      "env": {
        "USKAN_API_KEY": "usk_live_xxx"
      }
    }
  }
}
```

#### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.uskan]
command = "npx"
args = ["-y", "uskan-mcp"]
env = { USKAN_API_KEY = "usk_live_xxx" }
```

#### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "uskan": {
      "command": "npx",
      "args": ["-y", "uskan-mcp"],
      "env": {
        "USKAN_API_KEY": "usk_live_xxx"
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

### Environment variables

| Variable        | Required | Default             | Purpose                                   |
| --------------- | -------- | ------------------- | ----------------------------------------- |
| `USKAN_API_KEY` | yes      | —                   | Personal API token (`usk_live_…`).        |
| `USKAN_API_URL` | no       | `https://uskan.app` | Override the API origin (staging/self-host). |

The server starts and lists its tools even without a key — only the calls fail, with a
message telling the agent exactly what to do. The key is never logged, never echoed back
to the model, and is stripped out of error text.

---

## Tools

| Tool                           | Cost    | What it does                                                          |
| ------------------------------ | ------- | --------------------------------------------------------------------- |
| `uskan_status`                 | free    | Validates the token, returns credit balance + all your projects.       |
| `uskan_create_project`         | free    | Creates the project container (name, package ids, stack, build mode).  |
| `uskan_upload_build`           | free    | Uploads a `.aab`/`.apk`/`.ipa` and returns the inspected binary meta.  |
| `uskan_generate_listing`       | credits | AI store copy — title, subtitle, description, keywords, what's new.    |
| `uskan_save_listing`           | free    | Persists approved copy for one locale (upsert).                        |
| `uskan_prepare_questionnaires` | credits | Drafts Play Data safety (+ importable CSV) and IARC content rating.    |
| `uskan_publish`                | free    | Pushes an artifact to a store track and opens a submission.            |
| `uskan_build`                  | free    | Builds a signed release in your own repo via GitHub Actions.           |
| `uskan_build_status`           | free    | Status and log of a build started with `uskan_build`.                  |
| `uskan_upload_store_image`     | free    | Uploads a screenshot / feature graphic / icon, size-checked per store. |
| `uskan_file_data_safety`       | free    | Files the Play Data safety declaration with Google directly.           |
| `uskan_submit_ios_review`      | free    | Attaches the processed build and sends the iOS version to App Review.  |
| `uskan_check_submission`       | free    | Asks the store where a submission stands in review.                    |

Each tool's description is written for the agent, telling it which repo files to read
instead of interrogating you — `expo.android.package` from `app.json`, `applicationId`
from `build.gradle`, ad/analytics SDKs from your dependency list, locales from your i18n
folder, the app description from your README and source.

### Typical flow

```
uskan_status
  └─ uskan_create_project        (once per app)
       └─ uskan_upload_build     (your signed release build)
            ├─ uskan_generate_listing → review with you → uskan_save_listing (per locale)
            ├─ uskan_prepare_questionnaires → review with you
            ├─ uskan_file_data_safety  (after you approve the summary)
            ├─ uskan_upload_store_image (icon, feature graphic, screenshots)
            ├─ uskan_publish     (android: internal track by default)
            ├─ uskan_submit_ios_review (ios, after Apple finishes processing)
            └─ uskan_check_submission  (where the review stands)
```

### Example prompts

- "publish this app to Google Play with uskan"
- "use uskan to write App Store copy for this app in English, Turkish and German"
- "upload `build/app/outputs/bundle/release/app-release.aab` to uskan and draft the Play data safety form"
- "check my uskan credit balance and list my projects"

---

## Honest limitations

Publishing to a mobile store is not fully automatable, and this server does not pretend
otherwise:

- **The Play Console app record is a one-time manual step.** Google's Developer API cannot
  create an app. Before the first `uskan_publish` on Android, you must create the app in
  [Play Console](https://play.google.com/console) with the same package name and upload one
  build there by hand. The same goes for creating the app record in App Store Connect.
- **Store credentials are set up on the website**, never through this MCP server. The Play
  service-account JSON and the App Store Connect API key are added (encrypted) at
  <https://uskan.app/dashboard>. This server never touches, transmits or asks for them.
- **The screenshot studio is on the web.** Generating and sizing store screenshots happens
  at uskan.app; only the text side of the listing is exposed here.
- **uskan does not build your app in the default mode.** You run `eas build`,
  `flutter build appbundle`, `./gradlew bundleRelease` or an Xcode archive, and hand
  `uskan_upload_build` the resulting file. (Build-from-GitHub exists as a separate mode —
  `buildMode: "github"` — and requires connecting the GitHub App on the website first.)
- **AI output is a draft.** Store copy, data-safety declarations and content-rating answers
  must be reviewed by you before submission. You sign those declarations, and a wrong one
  gets the app rejected or pulled.
- **Review outcomes are not guaranteed.** uskan automates submission mechanics, not Apple's
  or Google's review decisions.
- **AI steps cost credits.** Top up at <https://uskan.app/dashboard/billing>.

---

## Development

```bash
npm install     # also builds via the prepare script
npm run build   # tsc → dist/
npm start       # run the server on stdio (it will just sit there waiting for a client)
```

Source lives in `src/` (TypeScript, ESM); the published entry point is `dist/index.js`.

## License

MIT

### Steps that happen in a browser

Creating the app record, getting store credentials and Apple's App Privacy
answers all live behind Apple's and Google's own login, so no MCP server can do
them. When a call fails for one of those reasons, uskan-mcp returns a `guides`
object with links already scoped to your project, and the agent hands you the
right one:

| Link | What you do there |
|------|-------------------|
| `iosApiKey` | Create the App Store Connect key, with the Key ID / Issuer ID trap explained |
| `androidServiceAccount` | Create the Play service account **and** invite it into Play Console |
| `iosAppRecord` / `androidAppRecord` | The one-time app entry neither store exposes over an API |
| `iosSubmitReview` | Send the finished iOS version to App Review |

