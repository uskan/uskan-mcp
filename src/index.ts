#!/usr/bin/env node
/**
 * uskan-mcp — Model Context Protocol server for uskan.app.
 *
 * Runs over stdio next to a coding agent (Claude Code, Cursor, Codex CLI,
 * Claude Desktop) inside the user's app repo. Because the agent is already in
 * the project folder, it can read app.json / pubspec.yaml / build.gradle /
 * README and fill in everything uskan.app's web forms would otherwise ask for.
 *
 * Config (environment):
 *   USKAN_API_KEY  personal API token, "usk_live_…" (required for every call)
 *   USKAN_API_URL  API origin, defaults to https://uskan.app
 *
 * The server always starts and always lists its tools, even with no API key —
 * only the individual calls fail, with a message telling the agent what to do.
 */
import { readFile, stat } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { basename, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  BILLING_URL,
  DASHBOARD_URL,
  UskanError,
  baseUrl,
  hasApiKey,
  redact,
  request,
  upload,
} from "./client.js";

/* ------------------------------------------------------------------ *
 * result helpers
 * ------------------------------------------------------------------ */

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Successful result: optional human/agent note, then the JSON payload. */
function ok(payload: unknown, note?: string): ToolResult {
  const json = JSON.stringify(payload, null, 2);
  const text = note ? `${note}\n\n${json}` : json;
  return { content: [{ type: "text", text: redact(text) }] };
}

/**
 * Deep links back into the dashboard. Text drafts can be reviewed in chat, but
 * visual work (screenshots) and final checks belong in the browser, so tools
 * hand the user a URL to look at what just happened.
 */
function links(projectId: string) {
  const base = `${baseUrl().replace(/\/$/, "")}/dashboard/projects/${projectId}`;
  return {
    project: base,
    storeText: `${base}/listing`,
    screenshots: `${base}/screenshots`,
    storeForms: `${base}/questionnaires`,
    publish: `${base}/publish`,
  };
}

/**
 * Deep links to the guided walkthroughs, already scoped to this project.
 *
 * Some steps cannot be done from an editor at all: they happen in Apple's or
 * Google's console, behind their login. When a call fails for one of those
 * reasons, the useful thing is not an apology but the exact page that explains
 * the clicks — with the user's own package name and app name already filled in.
 */
function guides(projectId: string) {
  const base = `${baseUrl().replace(/\/$/, "")}/dashboard/projects/${projectId}/publish`;
  return {
    /** Creating the app record by hand, once per app. Neither store has an API for it. */
    iosAppRecord: `${base}/ios/app-record`,
    androidAppRecord: `${base}/android/app-record`,
    /** Getting the store credentials, with the Key ID / Issuer ID trap spelled out. */
    iosApiKey: `${base}/ios/api-key`,
    androidServiceAccount: `${base}/android/service-account`,
    /** Sending the finished iOS version to App Review. */
    iosSubmitReview: `${base}/ios/review`,
  };
}

/** Failure result. Tools return errors as content so the agent can read + recover. */
function fail(err: unknown): ToolResult {
  const message =
    err instanceof UskanError || err instanceof Error
      ? err.message
      : String(err);
  return { content: [{ type: "text", text: redact(message) }], isError: true };
}

/** Wrap a tool body so no exception ever escapes as a protocol-level crash. */
function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch(fail);
}

/**
 * The API has grown a couple of response shapes over time (`{project:{…}}` vs a
 * flat object). Unwrap the named envelope when present, otherwise pass through.
 */
function unwrap<T = Record<string, unknown>>(data: unknown, key: string): T {
  if (data && typeof data === "object" && key in (data as object)) {
    return (data as Record<string, T>)[key] as T;
  }
  return data as T;
}

/* ------------------------------------------------------------------ *
 * shared enums
 * ------------------------------------------------------------------ */

const platformEnum = z.enum(["ios", "android"]);
const stackEnum = z.enum(["expo", "rn", "flutter", "gradle", "native"]);

/* ------------------------------------------------------------------ *
 * server
 * ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "uskan-mcp", version: "0.5.0" },
  {
    capabilities: { tools: {} },
    instructions: [
      "uskan.app publishes a finished mobile app to the App Store / Google Play:",
      "signing, store text, store questionnaires and the actual submission.",
      "",
      "You are running inside the user's app repository. Prefer READING the repo",
      "over interrogating the user: app.json (expo.name / expo.android.package /",
      "expo.ios.bundleIdentifier), pubspec.yaml, android/app/build.gradle",
      "(applicationId), ios/*.xcodeproj (PRODUCT_BUNDLE_IDENTIFIER), package.json,",
      "README.md and the i18n/locales folder already answer most of it. Only ask",
      "the user for what the repo genuinely cannot tell you (store category, the",
      "path to the signed build, whether to go to internal testing or production).",
      "",
      "Normal end-to-end order:",
      "  1. uskan_status               — check the key works and see existing projects",
      "  2. uskan_create_project       — once per app (reuse the id afterwards)",
      "  2b. uskan_manual_steps        — what the user must do in a browser, with links",
      "  3. uskan_upload_build         — the .aab / .ipa the user built",
      "  4. uskan_generate_listing     — AI store copy (costs credits)",
      "  5. uskan_save_listing         — persist the copy, per locale",
      "  6. uskan_prepare_questionnaires — Data safety + content rating drafts",
      "  3b. uskan_build             — instead of 3, when a GitHub repo is connected",
      "  7. uskan_publish              — push the artifact to the store track",
      "  8. uskan_submit_ios_review    — iOS only, once Apple finishes processing",
      "  9. uskan_check_submission     — where the review stands, when the user asks",
      "",
      "Store images: uskan_upload_store_image puts an existing PNG/JPEG into the",
      "right store slot and validates its pixel size. If the user has no artwork,",
      "point them at the screenshot studio link rather than trying to make one.",
      "Play Data safety: uskan_file_data_safety sends the declaration to Google",
      "directly, after the user has approved the summary.",
      "",
      "SOME STEPS CANNOT BE DONE FROM HERE, and that is not a failure. Creating the",
      "app record, getting store credentials, Apple's App Privacy answers and",
      "arranging screenshots all happen in a browser behind the user's own login.",
      "When a tool returns a `guides` object, give the user the matching URL as a",
      "clickable link and say in one sentence what they will do there. Do not try to",
      "work around these steps, and do not make the user hunt for the page.",
      "",
      "AI steps cost credits. Do not call them speculatively or in a retry loop.",
      "Always show generated store copy and questionnaire answers to the user for",
      "review before saving or submitting — the user is legally responsible for",
      "the declarations.",
    ].join("\n"),
  },
);

/* ------------------------------------------------------------------ *
 * 1. uskan_status
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_status",
  {
    title: "uskan: account status",
    description: [
      "Check the uskan.app connection: validates USKAN_API_KEY, returns the credit",
      "balance and every project this account owns (id, name, package ids, stack).",
      "",
      "Call this FIRST in any uskan workflow. It tells you whether the app already",
      "has a project (reuse its id — do not create a duplicate) and whether the",
      "user has enough credits for the AI steps. If the key is missing or invalid,",
      "the response says exactly what the user has to do; relay that instead of",
      "guessing at a token.",
    ].join("\n"),
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () =>
    guard(async () => {
      if (!hasApiKey()) {
        return fail(
          new UskanError(
            "USKAN_API_KEY is not set, so uskan-mcp cannot talk to " +
              `${baseUrl()}. Ask the user to create a personal API token at ` +
              `${DASHBOARD_URL} and add it to this MCP server's env as ` +
              'USKAN_API_KEY ("usk_live_…"), then restart the MCP server.',
            401,
          ),
        );
      }

      const [credits, projects] = await Promise.all([
        request<{ balance: number }>("/api/credits"),
        request<{ projects: unknown[] }>("/api/projects"),
      ]);

      const list = projects.projects ?? [];
      return ok(
        {
          apiUrl: baseUrl(),
          authenticated: true,
          balance: credits.balance,
          projectCount: list.length,
          projects: list,
        },
        list.length === 0
          ? "Connected. No projects yet — create one with uskan_create_project."
          : `Connected. ${list.length} project(s). Reuse an existing project id rather than creating a duplicate.`,
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 2. uskan_create_project
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_create_project",
  {
    title: "uskan: create project",
    description: [
      "Create a uskan.app project — the container that holds this app's builds,",
      "store listings and submissions. Do this ONCE per app; afterwards reuse the",
      "returned project id (uskan_status lists existing ones).",
      "",
      "Fill the arguments by READING THE REPO, not by asking the user:",
      "  • Expo / React Native → app.json or app.config.(js|ts): expo.name,",
      "    expo.android.package, expo.ios.bundleIdentifier",
      "  • bare React Native   → android/app/build.gradle applicationId,",
      "    ios/<App>.xcodeproj PRODUCT_BUNDLE_IDENTIFIER",
      "  • Flutter             → pubspec.yaml name, android/app/build.gradle",
      "    applicationId, ios/Runner.xcodeproj PRODUCT_BUNDLE_IDENTIFIER",
      "  • native Android      → build.gradle(.kts) applicationId",
      "Detect the stack the same way (expo dependency in package.json → 'expo';",
      "react-native without expo → 'rn'; pubspec.yaml → 'flutter'; a gradle-only",
      "tree → 'gradle'; anything else → 'native').",
      "",
      "At least one of androidPackage / iosPackage is REQUIRED by the API. If the",
      "repo only ships one platform, send only that one.",
    ].join("\n"),
    inputSchema: {
      name: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .describe("Display name of the app, e.g. expo.name from app.json."),
      androidPackage: z
        .string()
        .trim()
        .optional()
        .describe(
          "Android applicationId, e.g. com.acme.myapp (expo.android.package / build.gradle applicationId).",
        ),
      iosPackage: z
        .string()
        .trim()
        .optional()
        .describe(
          "iOS bundle identifier, e.g. com.acme.myapp (expo.ios.bundleIdentifier / PRODUCT_BUNDLE_IDENTIFIER).",
        ),
      stack: stackEnum
        .optional()
        .describe("Detected toolchain: expo | rn | flutter | gradle | native."),
      buildMode: z
        .enum(["upload", "github"])
        .optional()
        .describe(
          "'upload' (default) = the user brings the built .aab/.ipa (trust tier T3). " +
            "'github' = uskan builds from the connected GitHub repo (trust tier T1); " +
            "that requires the GitHub App to be connected on uskan.app first.",
        ),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  },
  async ({ name, androidPackage, iosPackage, stack, buildMode }) =>
    guard(async () => {
      if (!androidPackage && !iosPackage) {
        return fail(
          new UskanError(
            "At least one of androidPackage / iosPackage is required. Read the " +
              "package id out of app.json (expo.android.package / " +
              "expo.ios.bundleIdentifier), android/app/build.gradle (applicationId) " +
              "or the Xcode project (PRODUCT_BUNDLE_IDENTIFIER) before retrying.",
            400,
          ),
        );
      }

      const data = await request("/api/projects", {
        method: "POST",
        body: {
          name,
          ...(androidPackage ? { androidPackage } : {}),
          ...(iosPackage ? { iosPackage } : {}),
          ...(stack ? { stack } : {}),
          trustTier: buildMode === "github" ? "T1" : "T3",
        },
      });

      const project = unwrap<Record<string, unknown>>(data, "project");
      return ok(
        { project, review: links(String(project.id)) },
        `Project created. Use projectId "${String(project.id)}" for every following uskan call.`,
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 3. uskan_upload_build
 * ------------------------------------------------------------------ */

/** Open a file as a Blob, streaming when the runtime supports it. */
async function fileBlob(path: string): Promise<Blob> {
  const openAsBlob = (nodeFs as unknown as { openAsBlob?: (p: string) => Promise<Blob> })
    .openAsBlob;
  if (typeof openAsBlob === "function") return openAsBlob(path);
  // Node 18 fallback: buffer the file (builds are typically 20–150 MB).
  const buf = await readFile(path);
  return new Blob([new Uint8Array(buf)]);
}

server.registerTool(
  "uskan_upload_build",
  {
    title: "uskan: upload build artifact",
    description: [
      "Upload a signed release build (.aab / .apk for Android, .ipa for iOS) to a",
      "uskan project. uskan inspects the binary and returns what it found —",
      "package id, version, requested permissions, and whether ad/analytics SDKs",
      "are present.",
      "",
      "ALWAYS sanity-check the returned meta against the repo before moving on:",
      "if meta.package does not match the project's package id, or the version is",
      "older than the one in app.json / pubspec.yaml / build.gradle, tell the user",
      "they probably picked a stale artifact. Feed meta.usesAds / meta.usesAnalytics",
      "into uskan_prepare_questionnaires.",
      "",
      "uskan does not build the app for you in this mode — the user runs their own",
      "`eas build`, `flutter build appbundle`, `./gradlew bundleRelease` or Xcode",
      "archive first. Look for the output in build/, android/app/build/outputs/,",
      "or ask the user for the path.",
    ].join("\n"),
    inputSchema: {
      projectId: z
        .string()
        .trim()
        .min(1)
        .describe("uskan project id from uskan_create_project / uskan_status."),
      filePath: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Path to the built artifact on this machine. Absolute, or relative to the agent's working directory.",
        ),
      platform: platformEnum.describe(
        "'android' for .aab/.apk, 'ios' for .ipa. Must match the file extension.",
      ),
      version: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe(
          "Optional marketing version, e.g. '1.4.0'. Omit to let uskan read it from the binary.",
        ),
    },
    annotations: { openWorldHint: true },
  },
  async ({ projectId, filePath, platform, version }) =>
    guard(async () => {
      const abs = resolve(filePath);

      let info;
      try {
        info = await stat(abs);
      } catch {
        return fail(
          new UskanError(
            `No file at ${abs}. Check the path — Android bundles usually land in ` +
              "android/app/build/outputs/bundle/release/app-release.aab or " +
              "build/app/outputs/bundle/release/ (Flutter); EAS builds have to be " +
              "downloaded first. Ask the user for the artifact path if you cannot find it.",
            404,
          ),
        );
      }
      if (!info.isFile()) {
        return fail(new UskanError(`${abs} is a directory, not a build artifact.`, 400));
      }
      if (info.size === 0) {
        return fail(new UskanError(`${abs} is empty (0 bytes).`, 400));
      }

      const ext = (abs.split(".").pop() || "").toLowerCase();
      const expected: Record<string, "ios" | "android"> = {
        aab: "android",
        apk: "android",
        ipa: "ios",
      };
      const extPlatform = expected[ext];
      if (!extPlatform) {
        return fail(
          new UskanError(
            `Unsupported artifact type ".${ext}". Upload a .aab (preferred) or .apk ` +
              "for Android, or a .ipa for iOS — not a zip, xcarchive or app bundle folder.",
            400,
          ),
        );
      }
      if (extPlatform !== platform) {
        return fail(
          new UskanError(
            `platform "${platform}" does not match the file extension ".${ext}" ` +
              `(that is a ${extPlatform} artifact). Fix one of the two and retry.`,
            400,
          ),
        );
      }
      if (platform === "android" && ext === "apk") {
        // Not fatal: Play requires AAB for new releases, but keep going.
      }

      const data = await upload(
        "/api/artifacts",
        {
          projectId,
          platform,
          ...(version ? { version } : {}),
        },
        { blob: await fileBlob(abs), name: basename(abs) },
      );

      const artifact = unwrap<Record<string, unknown>>(data, "artifact");
      const meta = (artifact.meta ?? {}) as Record<string, unknown>;
      const notes: string[] = [
        `Uploaded ${basename(abs)} (${(info.size / 1_048_576).toFixed(1)} MB). ` +
          `artifactId "${String(artifact.id)}" — pass it to uskan_publish.`,
      ];
      if (ext === "apk") {
        notes.push(
          "NOTE: Google Play requires an .aab for new releases; an .apk only works " +
            "for legacy apps or internal sharing. Consider rebuilding as an app bundle.",
        );
      }
      notes.push(
        "Verify meta.package / meta.version against the repo before publishing.",
      );
      if (meta.usesAds === true || meta.usesAnalytics === true) {
        notes.push(
          "Ad/analytics SDKs detected — reflect that in uskan_prepare_questionnaires.",
        );
      }

      return ok(
        { artifact, review: links(projectId) },
        notes.join("\n"),
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 4. uskan_generate_listing
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_generate_listing",
  {
    title: "uskan: generate store listing copy",
    description: [
      "Generate ASO-optimised store listing copy (title, subtitle, description,",
      "keywords, what's new) for every requested locale. COSTS CREDITS — call it",
      "once with all the locales you need, not once per locale, and never in a",
      "retry loop.",
      "",
      "Derive the arguments from the repo instead of asking the user:",
      "  • description → summarise README.md, the landing copy, and the actual",
      "    screens/features in src/ (routes, screen names, key components). Write",
      "    3-6 sentences about what the app DOES and who it is for. A vague input",
      "    produces vague, rejectable store copy.",
      "  • locales → the app's i18n folder (locales/, src/i18n/, assets/lang/,",
      "    intl_*.arb for Flutter). Map each to a full store locale tag: en→en-US,",
      "    tr→tr-TR, de→de-DE, pt→pt-BR. Default to ['en-US'] if the app is",
      "    single-language.",
      "  • appName → app.json expo.name / pubspec.yaml name / the value in strings.xml.",
      "  • category → the store category (e.g. 'Productivity', 'Education',",
      "    'Health & Fitness'). If the repo does not imply one clearly, ask the user.",
      "",
      "The result is a DRAFT. Show it to the user, let them edit, then persist the",
      "approved text with uskan_save_listing (this tool does not save anything).",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      appName: z.string().trim().min(1).max(255).describe("The app's display name."),
      description: z
        .string()
        .trim()
        .min(1)
        .describe(
          "What the app does, its main features and target user — distilled from README + source. The more concrete, the better the copy.",
        ),
      platforms: z
        .array(platformEnum)
        .min(1)
        .describe("Stores to write for: ['android'], ['ios'] or both."),
      category: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("Store category, e.g. 'Productivity' or 'Health & Fitness'."),
      locales: z
        .array(z.string().trim().min(2).max(16))
        .min(1)
        .describe(
          "Store locale tags to generate, e.g. ['en-US','tr-TR','de-DE'] — derived from the app's i18n files.",
        ),
      tone: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe("Optional voice hint, e.g. 'playful', 'clinical', 'developer-to-developer'."),
    },
    annotations: { openWorldHint: true },
  },
  async ({ projectId, appName, description, platforms, category, locales, tone }) =>
    guard(async () => {
      const data = await request<{ result: unknown; price?: number; balance?: number }>(
        "/api/ai/listing",
        {
          method: "POST",
          body: {
            projectId,
            appName,
            description,
            platforms,
            category,
            locales,
            ...(tone ? { tone } : {}),
          },
        },
      );

      return ok(
        {
          listings: unwrap(data.result, "listings"),
          price: data.price,
          balance: data.balance,
          review: links(projectId),
        },
        "Draft copy generated (credits charged). Show the full text to the user for " +
          "review before saving; they may want wording changes or extra locales. " +
          "Then persist the approved text per locale with uskan_save_listing. " +
          "The review.storeText link opens the same text in the browser, side by side " +
          "per locale with the store character limits. Screenshots are visual work: " +
          "point the user at review.screenshots instead of trying to make them here. " +
          "Check length limits: Play title 30 chars, App Store title 30 / subtitle 30 / keywords 100.",
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 5. uskan_save_listing
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_save_listing",
  {
    title: "uskan: save store listing",
    description: [
      "Persist the store listing text for ONE locale on a uskan project (upsert:",
      "calling it again for the same locale overwrites that locale). Free — no",
      "credits. Call it once per locale after the user has approved the copy from",
      "uskan_generate_listing, or to hand-write/patch a single field.",
      "",
      "Only send the fields you want to set; omitted fields are left blank for a",
      "new locale. Length limits worth respecting: Play title 30, short description",
      "80, full description 4000; App Store title 30, subtitle 30, keywords 100",
      "(comma-separated, no spaces).",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      locale: z
        .string()
        .trim()
        .min(2)
        .max(16)
        .describe("Store locale tag, e.g. 'en-US', 'tr-TR', 'pt-BR'."),
      title: z.string().max(255).optional().describe("App title / store name (≤30 chars)."),
      subtitle: z
        .string()
        .max(255)
        .optional()
        .describe("App Store subtitle / Play short description."),
      keywords: z
        .string()
        .max(1000)
        .optional()
        .describe("App Store keywords, comma-separated without spaces (≤100 chars total)."),
      description: z.string().max(20000).optional().describe("Full store description."),
      whatsNew: z
        .string()
        .max(20000)
        .optional()
        .describe("Release notes for this version (derive from the changelog or recent commits)."),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  async (args) =>
    guard(async () => {
      const data = await request("/api/listings", { method: "PUT", body: args });
      return ok(
        { listing: unwrap(data, "listing"), review: links(args.projectId) },
        `Saved listing for ${args.locale}. Repeat for each remaining locale.`,
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 6. uskan_prepare_questionnaires
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_prepare_questionnaires",
  {
    title: "uskan: prepare store questionnaires",
    description: [
      "Draft the two compliance questionnaires Google Play blocks a release on:",
      "  • Data safety — per-data-type collected/shared/purpose entries, plus a CSV",
      "    the user can import directly into Play Console.",
      "  • Content rating (IARC) — answers with rationales and a suggested rating.",
      "COSTS CREDITS (two AI calls). Call once, then iterate with the user by hand.",
      "",
      "Detect the flags from the repo instead of asking:",
      "  • usesAds → react-native-google-mobile-ads, expo-ads-admob, google_mobile_ads,",
      "    applovin, unity-ads, com.google.android.gms:play-services-ads in",
      "    package.json / pubspec.yaml / build.gradle; also the AD_ID permission and",
      "    the meta.usesAds flag returned by uskan_upload_build.",
      "  • usesAnalytics → firebase/analytics, @amplitude/*, posthog, mixpanel,",
      "    @sentry/*, expo-firebase-analytics.",
      "  • hasAccounts → any auth dependency or login screen (firebase/auth,",
      "    @supabase/supabase-js, next-auth, @react-native-google-signin, an",
      "    email/password form).",
      "State your evidence to the user when you set a flag.",
      "",
      "These are DRAFTS for a human to verify. The user signs the declaration and is",
      "legally responsible for it — never submit without showing them the answers,",
      "and never under-declare data collection to make the form shorter.",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      appName: z.string().trim().min(1).max(255).describe("The app's display name."),
      description: z
        .string()
        .trim()
        .min(1)
        .describe(
          "What the app does AND what data it actually touches (accounts, location, photos, contacts, analytics, ads, crash logs, payments).",
        ),
      usesAds: z
        .boolean()
        .optional()
        .describe("True if an ad SDK ships in the build (see the detection list above)."),
      usesAnalytics: z
        .boolean()
        .optional()
        .describe("True if an analytics or crash-reporting SDK ships in the build."),
      hasAccounts: z
        .boolean()
        .optional()
        .describe("True if users can sign in / the app stores a user account."),
      hasInAppPurchases: z
        .boolean()
        .optional()
        .describe("True if IAP or subscriptions ship (react-native-iap, expo-in-app-purchases, in_app_purchase, RevenueCat)."),
      userGeneratedContent: z
        .boolean()
        .optional()
        .describe("True if users can post, upload, chat or otherwise share content with other users."),
      category: z
        .string()
        .trim()
        .max(120)
        .optional()
        .describe("Store category, if known — improves both drafts."),
    },
    annotations: { openWorldHint: true },
  },
  async ({
    projectId,
    appName,
    description,
    usesAds,
    usesAnalytics,
    hasAccounts,
    hasInAppPurchases,
    userGeneratedContent,
    category,
  }) =>
    guard(async () => {
      const dataSafetyBody = {
        projectId,
        appName,
        description,
        ...(category ? { category } : {}),
        ...(usesAds === undefined ? {} : { usesAds }),
        ...(usesAnalytics === undefined ? {} : { usesAnalytics }),
        ...(hasAccounts === undefined ? {} : { hasAccounts }),
      };
      const contentRatingBody = {
        projectId,
        appName,
        description,
        ...(category ? { category } : {}),
        // The content-rating endpoint uses its own field names.
        ...(usesAds === undefined ? {} : { hasAds: usesAds }),
        ...(hasInAppPurchases === undefined ? {} : { hasInAppPurchases }),
        ...(userGeneratedContent === undefined ? {} : { userGeneratedContent }),
      };

      type AiResponse = { result: unknown; price?: number; balance?: number };

      // Run sequentially so a failure on the second one still returns the first
      // (both are billed independently and neither charges on failure).
      const dataSafety = await request<AiResponse>("/api/ai/data-safety", {
        method: "POST",
        body: dataSafetyBody,
      });

      let contentRating: AiResponse | null = null;
      let contentRatingError: string | null = null;
      try {
        contentRating = await request<AiResponse>("/api/ai/content-rating", {
          method: "POST",
          body: contentRatingBody,
        });
      } catch (err) {
        contentRatingError = err instanceof Error ? err.message : String(err);
      }

      const notes = [
        "Both drafts are for HUMAN REVIEW. Walk the user through the data-safety",
        "entries and the rating answers before anything is submitted — a wrong",
        "declaration gets the app rejected or pulled.",
        "The `csv` field can be imported straight into Play Console → Data safety.",
      ];
      if (contentRatingError) {
        notes.push(`Content rating draft FAILED (no credits charged): ${contentRatingError}`);
      }

      return ok(
        {
          dataSafety: dataSafety.result,
          contentRating: contentRating?.result ?? null,
          contentRatingError,
          balance: contentRating?.balance ?? dataSafety.balance,
          review: links(projectId),
        },
        notes.join("\n"),
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 7. uskan_publish
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_publish",
  {
    title: "uskan: publish to store",
    description: [
      "Push an uploaded artifact to the store and open a submission record.",
      "",
      "PRE-FLIGHT — confirm ALL of these with the user before calling, because the",
      "call will simply fail otherwise:",
      "  1. GOOGLE PLAY: the app record must ALREADY EXIST in Play Console with the",
      "     exact same package name, and a first build must have been uploaded",
      "     there manually at least once. The Google Play Developer API CANNOT",
      "     create an app — this is a one-time manual step at",
      "     https://play.google.com/console. If the app is brand new, stop and tell",
      "     the user to create it first.",
      "  2. APP STORE: the app record must exist in App Store Connect with the same",
      "     bundle id.",
      "  3. STORE CREDENTIALS must be connected on uskan.app for this project — the",
      "     Play service-account JSON and/or the App Store Connect API key are added",
      "     on the website (they are never handled through this MCP server). Without",
      "     them publish returns 'No play_sa/asc_key credential stored for this project'.",
      "  4. Screenshots, the app icon, pricing and the store-listing form still live",
      "     in Play Console / App Store Connect (or uskan's web screenshot studio).",
      "",
      "Publishing is a real, external, irreversible-ish action: ALWAYS get explicit",
      "user confirmation of platform + track first. Default to the 'internal' track",
      "for Android and TestFlight for iOS; only go to 'production' when the user",
      "asks for it in so many words.",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      platform: platformEnum.describe("Store to publish to."),
      artifactId: z
        .string()
        .trim()
        .min(1)
        .describe("Artifact id returned by uskan_upload_build. Must match `platform`."),
      track: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe(
          "Android: 'internal' (default) | 'alpha' | 'beta' | 'production'. iOS: 'testflight' (default) | 'appstore'.",
        ),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ projectId, platform, artifactId, track }) =>
    guard(async () => {
      const resolvedTrack =
        track ?? (platform === "android" ? "internal" : "testflight");

      const body: Record<string, unknown> = { projectId, platform, artifactId };
      if (platform === "android") {
        body.track = resolvedTrack;
      } else {
        body.channel = resolvedTrack === "appstore" ? "appstore" : "testflight";
      }

      let data: unknown;
      try {
        data = await request("/api/publish", { method: "POST", body });
      } catch (err) {
        // The two failures that are not fixable from an editor: no credential,
        // and no app record. Both are console work, so hand over the exact
        // walkthrough for THIS project instead of restating the error.
        const msg = err instanceof Error ? err.message : String(err);
        const g = guides(projectId);
        if (/credential|asc_key|play_sa|api key|service account/i.test(msg)) {
          return fail(
            new UskanError(
              `${msg}\n\nThis is set up in the browser, once per developer account. ` +
                `Send the user here and they will be walked through it:\n` +
                (platform === "ios" ? g.iosApiKey : g.androidServiceAccount),
              400,
            ),
          );
        }
        if (
          /app record|does not exist|no app with|not found in|create the app/i.test(
            msg,
          )
        ) {
          return fail(
            new UskanError(
              `${msg}\n\nNeither store lets us create the app entry over the API, so ` +
                `this one screen is the user's to click through, once per app:\n` +
                (platform === "ios" ? g.iosAppRecord : g.androidAppRecord),
              400,
            ),
          );
        }
        throw err;
      }
      const submission = unwrap<Record<string, unknown>>(data, "submission");

      return ok(
        {
          submission,
          track: resolvedTrack,
          review: links(projectId),
          guides: guides(projectId),
        },
        [
          `Submitted to ${platform} / ${resolvedTrack}.`,
          platform === "android"
            ? "The release lands as a DRAFT on that track — the user still has to review and roll it out in Play Console."
            : "The build now goes through Apple's processing (10-60 min). Your listing text and screenshots were written at the same time. When processing finishes, call uskan_submit_ios_review to send it to review.",
          "Track progress on the uskan dashboard and in the store console.",
        ].join("\n"),
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 8. uskan_build
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_build",
  {
    title: "uskan: build the app on GitHub Actions",
    description: [
      "Build a signed release from the project's connected GitHub repository, so",
      "the user does not have to run `flutter build appbundle`, `eas build` or an",
      "Xcode archive themselves. The build runs in THEIR repo under GitHub Actions;",
      "uskan injects the signing keys as repo secrets for that one run and never",
      "receives the source.",
      "",
      "REQUIRES: the project was created with a connected GitHub repo, and the",
      "signing credentials are stored on uskan.app (Android upload keystore for",
      "Android, App Store Connect API key for iOS). If no repo is connected this",
      "returns 409 — in that case the user builds locally and you call",
      "uskan_upload_build instead.",
      "",
      "This returns as soon as the workflow is dispatched. Poll uskan_build_status",
      "with the returned id; a cold Flutter or Xcode build takes 5-20 minutes.",
      "When it reports success, the artifact is already attached to the project and",
      "ready for uskan_publish.",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      platform: platformEnum.describe("Which build to run."),
      ref: z
        .string()
        .trim()
        .max(255)
        .optional()
        .describe("Branch or tag to build. Defaults to the project's stored branch."),
      versionName: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe("Marketing version, e.g. '1.4.0'. Read it from app.json / pubspec.yaml."),
      versionCode: z
        .string()
        .trim()
        .max(16)
        .optional()
        .describe("Android version code (integer as a string). Must increase every release."),
      buildNumber: z
        .string()
        .trim()
        .max(16)
        .optional()
        .describe("iOS CFBundleVersion. Must increase every upload to App Store Connect."),
    },
    annotations: { openWorldHint: true },
  },
  async ({ projectId, platform, ref, versionName, versionCode, buildNumber }) =>
    guard(async () => {
      const body: Record<string, unknown> = { projectId, platform };
      if (ref) body.ref = ref;
      if (versionName) body.versionName = versionName;
      if (platform === "android" && versionCode) body.versionCode = versionCode;
      if (platform === "ios" && buildNumber) body.buildNumber = buildNumber;

      const data = await request<Record<string, unknown>>("/api/builds", {
        method: "POST",
        body,
      });

      return ok({ build: data, review: links(projectId) }, [
        `Build dispatched for ${platform}. id: ${String(data.id ?? "unknown")}`,
        "Poll uskan_build_status with that id. Do not poll faster than once every",
        "30 seconds, and tell the user roughly how long builds take (5-20 minutes)",
        "instead of sitting silent.",
      ].join("\n"));
    }),
);

/* ------------------------------------------------------------------ *
 * 9. uskan_build_status
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_build_status",
  {
    title: "uskan: check a build",
    description: [
      "Status and log of a build started with uskan_build.",
      "",
      "status is one of: queued, running, success, failed, cancelled. On failure",
      "the `logs` array says which step stopped it — read it and explain the cause",
      "to the user rather than just repeating 'the build failed'. Common ones: a",
      "version code that is not higher than the last release, a missing keystore",
      "credential, or a compile error in the app itself (which is the user's to fix).",
    ].join("\n"),
    inputSchema: {
      buildId: z.string().trim().min(1).describe("Build id returned by uskan_build."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ buildId }) =>
    guard(async () => {
      const data = await request<Record<string, unknown>>(
        `/api/builds/${encodeURIComponent(buildId)}`,
      );
      const status = String(data.status ?? "unknown");
      const note =
        status === "success"
          ? "Build finished. The artifact is attached to the project and ready for uskan_publish."
          : status === "failed" || status === "cancelled"
            ? `Build ${status}. Read the logs below and tell the user what actually stopped it.`
            : `Build is ${status}. Wait at least 30 seconds before checking again.`;
      return ok(data, note);
    }),
);

/* ------------------------------------------------------------------ *
 * 10. uskan_upload_store_image
 * ------------------------------------------------------------------ */

const imageKindEnum = z.enum([
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "featureGraphic",
  "icon",
  "APP_IPHONE_67",
  "APP_IPAD_PRO_3GEN_129",
]);

server.registerTool(
  "uskan_upload_store_image",
  {
    title: "uskan: upload a store image",
    description: [
      "Upload one screenshot, feature graphic or store icon from disk into a",
      "project's store assets. uskan reads the real pixel size of the file and",
      "rejects anything the store would reject, so a failure here is a rejection",
      "the user does not get later.",
      "",
      "The rules, which are worth checking BEFORE uploading:",
      "  - Play app icon:      exactly 512 x 512",
      "  - Play feature graphic: exactly 1024 x 500",
      "  - Play screenshots:   each side 320-3840 px, never longer than 2:1, no",
      "                        transparency, at least 2 of them",
      "  - App Store iPhone:   1320 x 2868 or 1290 x 2796",
      "  - App Store iPad:     2064 x 2752 or 2048 x 2732",
      "",
      "If the user has no artwork yet, do NOT try to generate it here: send them to",
      "the screenshot studio link this tool returns, where raw device screenshots",
      "get framed and exported at the right sizes.",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      filePath: z
        .string()
        .trim()
        .min(1)
        .describe("Path to a PNG or JPEG on this machine."),
      platform: platformEnum.describe("Which store this image is for."),
      kind: imageKindEnum.describe(
        "Which slot it fills. Android: phoneScreenshots | sevenInchScreenshots | tenInchScreenshots | featureGraphic | icon. iOS: APP_IPHONE_67 | APP_IPAD_PRO_3GEN_129.",
      ),
      locale: z
        .string()
        .trim()
        .max(16)
        .optional()
        .describe("Store locale, e.g. 'en-US' (default) or 'tr-TR'."),
      sort: z
        .number()
        .int()
        .min(0)
        .max(9)
        .optional()
        .describe("Display order within the slot, 0 first. Screenshots are shown in this order."),
    },
    annotations: { openWorldHint: true },
  },
  async ({ projectId, filePath, platform, kind, locale, sort }) =>
    guard(async () => {
      const abs = resolve(filePath);
      let info;
      try {
        info = await stat(abs);
      } catch {
        return fail(new UskanError(`No file at ${abs}.`, 404));
      }
      if (!info.isFile()) {
        return fail(new UskanError(`${abs} is a directory, not an image.`, 400));
      }
      const ext = (abs.split(".").pop() || "").toLowerCase();
      if (!["png", "jpg", "jpeg"].includes(ext)) {
        return fail(
          new UskanError(
            `Store images must be PNG or JPEG, not ".${ext}". Convert it first.`,
            400,
          ),
        );
      }

      const data = await upload(
        "/api/screenshots",
        {
          projectId,
          platform,
          kind,
          locale: locale ?? "en-US",
          ...(sort === undefined ? {} : { sort: String(sort) }),
        },
        { blob: await fileBlob(abs), name: basename(abs) },
      );

      return ok(
        {
          image: unwrap(data, "screenshot"),
          review: links(projectId),
          studio: links(projectId).screenshots,
        },
        [
        `Added ${basename(abs)} to ${kind} (${locale ?? "en-US"}).`,
        "Show the user the screenshots link so they can see the set in context",
        "before publishing.",
        ].join("\n"),
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 11. uskan_file_data_safety
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_file_data_safety",
  {
    title: "uskan: file the Play Data safety form",
    description: [
      "Send the Google Play Data safety declaration straight to Play, so the user",
      "never opens that form. It takes the full Play CSV that",
      "uskan_prepare_questionnaires produces (dataSafetyCsv in its result).",
      "",
      "The user is legally responsible for this declaration. ALWAYS show them the",
      "human-readable summary from uskan_prepare_questionnaires and get an explicit",
      "yes before calling this. Do not file a declaration you assembled from",
      "guesswork about what the app collects.",
      "",
      "Filing applies immediately and independently of any release, so it can be",
      "done before a build exists.",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      csv: z
        .string()
        .min(100)
        .describe(
          "The complete Play Data safety CSV, starting with the header 'Question ID (machine readable)'. Pass dataSafetyCsv from uskan_prepare_questionnaires verbatim.",
        ),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ projectId, csv }) =>
    guard(async () => {
      if (!csv.startsWith("Question ID (machine readable)")) {
        return fail(
          new UskanError(
            "That is not a Play Data safety CSV. Use the dataSafetyCsv value from " +
              "uskan_prepare_questionnaires exactly as returned, without reformatting it.",
            400,
          ),
        );
      }
      const data = await request<Record<string, unknown>>("/api/data-safety/push", {
        method: "POST",
        body: { projectId, csv },
      });
      return ok(
        { result: data, review: links(projectId) },
        "Data safety filed with Google Play. It shows up in Play Console under App content.",
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 12. uskan_check_submission
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_check_submission",
  {
    title: "uskan: check a submission's review status",
    description: [
      "Ask the store where a submission stands and update uskan's record of it.",
      "",
      "Returns one of: processing, submitted, live, rejected, failed. Review times",
      "are the store's, not ours: Apple is typically 24-48 hours, Google Play a few",
      "hours to 7 days for a first release. Do not poll this in a loop — check when",
      "the user asks, and tell them the expected wait instead.",
      "",
      "uskan does not and cannot guarantee approval: whether an app is accepted",
      "depends entirely on the app's own design and content against each store's",
      "review guidelines.",
    ].join("\n"),
    inputSchema: {
      submissionId: z
        .string()
        .trim()
        .min(1)
        .describe("Submission id returned by uskan_publish."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ submissionId }) =>
    guard(async () => {
      const data = await request<Record<string, unknown>>("/api/submissions/status", {
        method: "POST",
        body: { submissionId },
      });
      const status = String(data.status ?? "unknown");
      const note =
        status === "live"
          ? "The release is live on the store."
          : status === "rejected"
            ? "The store rejected it. The response below carries the store's reason; relay that to the user verbatim."
            : `Status: ${status}. Reviews take the store's own time; do not poll repeatedly.`;
      return ok(data, note);
    }),
);

/* ------------------------------------------------------------------ *
 * 13. uskan_submit_ios_review
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_submit_ios_review",
  {
    title: "uskan: submit the iOS version to App Review",
    description: [
      "The last iOS step. uskan_publish delivers the .ipa and writes the listing,",
      "but Apple processes every build asynchronously (10-60 minutes) and a version",
      "can only be submitted once that finishes. This attaches the processed build",
      "to the version and sends it to review.",
      "",
      "Safe to call early: if Apple is still processing, it returns pending:true,",
      "changes nothing, and you try again later. Do not loop on it — tell the user",
      "the wait and check when they ask.",
      "",
      "Apple REQUIRES a review contact. If any part of the app is behind a login,",
      "you MUST also pass a working test account: a reviewer who cannot reach the",
      "main screens rejects the app for incomplete information, and that is the",
      "single most common avoidable rejection. Ask the user for both rather than",
      "inventing values.",
      "",
      "IN-APP PURCHASES: uskan sends any unreviewed in-app purchases and",
      "subscriptions to review together with the version. This matters more than it",
      "sounds — a product left in READY_TO_SUBMIT means the app ships, the paywall",
      "opens, and every purchase silently fails. The result carries",
      "inAppPurchases.stillUnreviewed; if that list is not empty, TELL THE USER the",
      "product ids by name and that those purchases will not work until they are",
      "fixed in App Store Connect (usually a missing price, localization or review",
      "screenshot). Do not bury it.",
      "",
      "uskan does not and cannot guarantee approval: that depends entirely on the",
      "app's own design and content against Apple's review guidelines.",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      firstName: z.string().trim().min(1).max(64).describe("Review contact first name."),
      lastName: z.string().trim().min(1).max(64).describe("Review contact last name."),
      phone: z.string().trim().min(3).max(32).describe("Review contact phone, with country code."),
      email: z.string().trim().email().describe("Review contact email."),
      demoAccountName: z
        .string()
        .trim()
        .max(255)
        .optional()
        .describe("Test account username, REQUIRED if any screen needs a login."),
      demoAccountPassword: z
        .string()
        .trim()
        .max(255)
        .optional()
        .describe("Test account password, REQUIRED if any screen needs a login."),
      notes: z
        .string()
        .max(4000)
        .optional()
        .describe(
          "Notes for the reviewer: what a non-obvious feature does, why a permission is needed, how to reach a screen.",
        ),
      buildNumber: z
        .string()
        .trim()
        .max(32)
        .optional()
        .describe("Which build to submit. Defaults to the last one uskan delivered."),
      submit: z
        .boolean()
        .optional()
        .describe("false to attach the build without sending it to review. Defaults to true."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({
    projectId,
    firstName,
    lastName,
    phone,
    email,
    demoAccountName,
    demoAccountPassword,
    notes,
    buildNumber,
    submit,
  }) =>
    guard(async () => {
      if (Boolean(demoAccountName) !== Boolean(demoAccountPassword)) {
        return fail(
          new UskanError(
            "A reviewer test account needs both a username and a password. Ask the " +
              "user for the missing half, or omit both if the app has no login.",
            400,
          ),
        );
      }

      const data = await request<Record<string, unknown>>("/api/publish/ios/submit", {
        method: "POST",
        body: {
          projectId,
          buildNumber,
          submit,
          reviewContact: {
            firstName,
            lastName,
            phone,
            email,
            demoAccountName,
            demoAccountPassword,
            notes,
          },
        },
      });

      const iap = data.inAppPurchases as
        | { submittedWithApp?: string[]; stillUnreviewed?: string[] }
        | undefined;
      const lines: string[] = [];
      if (data.pending) {
        lines.push("Apple is still processing the build. Nothing was changed — check again in a while.");
      } else if (data.submitted) {
        lines.push("Submitted to App Review. Apple typically answers within 24-48 hours.");
        if (iap?.submittedWithApp?.length) {
          lines.push(`In-app purchases sent with it: ${iap.submittedWithApp.join(", ")}.`);
        }
      } else {
        lines.push("The build is attached to the version but was not sent to review.");
      }
      if (iap?.stillUnreviewed?.length) {
        lines.push(
          `WARNING — these purchases were NOT reviewed and will fail in production: ${iap.stillUnreviewed.join(", ")}. ` +
            "Report this to the user before anything else.",
        );
      }
      const note = lines.join("\n");

      return ok(
        { ...data, review: links(projectId), guides: guides(projectId) },
        note,
      );
    }),
);

/* ------------------------------------------------------------------ *
 * 14. uskan_manual_steps
 * ------------------------------------------------------------------ */

server.registerTool(
  "uskan_manual_steps",
  {
    title: "uskan: what only the user can do",
    description: [
      "The steps of a launch that no API can perform, for this project, with a",
      "link to a walkthrough that shows each one with real screenshots.",
      "",
      "Call this EARLY — right after uskan_create_project — and again whenever a",
      "publish fails for a setup reason. These steps take the user a few minutes",
      "in a browser, and every one of them blocks publishing, so finding out about",
      "them at the end is the worst possible time.",
      "",
      "Why they cannot be automated, so you can answer the user honestly:",
      "  - The app record: neither store has a create-app endpoint. Apple's API",
      "    can read apps but not make one; Google's can only change an app that",
      "    already exists. It is one screen, once per app.",
      "  - Store credentials: an API key has to be issued from inside the user's",
      "    own account. On Google there is a second half people miss — the service",
      "    account must also be INVITED into Play Console.",
      "  - Apple's App Privacy answers: no API exists at all.",
      "",
      "Give the user the URLs as clickable links with one sentence each. Do not",
      "paraphrase the steps from memory — the pages carry current screenshots and",
      "the user's own package name.",
    ].join("\n"),
    inputSchema: {
      projectId: z.string().trim().min(1).describe("uskan project id."),
      platform: platformEnum
        .optional()
        .describe("Limit to one store. Omit to get both."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ projectId, platform }) =>
    guard(async () => {
      const g = guides(projectId);

      // What we can already tell: which credentials exist. Everything else
      // lives inside the stores, where we cannot look without trying to publish.
      let haveAsc = false;
      let havePlay = false;
      try {
        const creds = await request<{ credentials: { type: string }[] }>(
          `/api/credentials?projectId=${encodeURIComponent(projectId)}`,
        );
        for (const c of creds.credentials ?? []) {
          if (c.type === "asc_key") haveAsc = true;
          if (c.type === "play_sa") havePlay = true;
        }
      } catch {
        // Listing is a convenience; the checklist is still worth returning.
      }

      const ios = [
        {
          step: "Get your App Store Connect API key",
          done: haveAsc,
          why: "uskan needs it to upload the build and write your listing. One key covers every app you ever publish.",
          url: g.iosApiKey,
        },
        {
          step: "Create the app record in App Store Connect",
          done: null,
          why: "Apple's API can read apps but cannot create one. Two screens, once per app.",
          url: g.iosAppRecord,
        },
        {
          step: "Fill in App Privacy",
          done: null,
          why: "Apple exposes no API for the privacy questions. uskan prepares the answers for you to copy.",
          url: g.iosAppRecord,
        },
        {
          step: "Send the version to App Review",
          done: null,
          why: "Runs after Apple finishes processing the build. You can do it from here with uskan_submit_ios_review, or in the browser.",
          url: g.iosSubmitReview,
        },
      ];

      const android = [
        {
          step: "Create a Play service account and invite it",
          done: havePlay,
          why: "Two halves in two different places. A key without the Play Console invitation authenticates fine and then cannot see your app.",
          url: g.androidServiceAccount,
        },
        {
          step: "Create the app record in Play Console",
          done: null,
          why: "The Play Developer API can only change an app that already exists. One screen, once per app.",
          url: g.androidAppRecord,
        },
      ];

      const steps =
        platform === "ios"
          ? { ios }
          : platform === "android"
            ? { android }
            : { ios, android };

      return ok(
        { steps, guides: g },
        [
          "These are the parts of publishing that happen in the user's browser.",
          "`done: true` means uskan already has it. `done: null` means we cannot",
          "check from here — ask the user rather than assuming.",
          "Send them the links; each page walks through the clicks with screenshots.",
        ].join("\n"),
      );
    }),
);

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — diagnostics must go to stderr only, and must
  // never contain the API key.
  process.stderr.write(
    `uskan-mcp ready (api ${baseUrl()}, key ${hasApiKey() ? "set" : "MISSING — see " + DASHBOARD_URL}, billing ${BILLING_URL})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`uskan-mcp failed to start: ${redact(String(err))}\n`);
  process.exit(1);
});
