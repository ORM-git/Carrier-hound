const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPORT_DIR = path.resolve(__dirname, "..", "reports", "admin-a1");
const CSS_DIR = path.resolve(__dirname, "..", "out", "_next", "static", "css");

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

// Find all compiled Tailwind CSS files
const cssFiles = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));
const cssLinks = cssFiles
  .map((f) => `<link rel="stylesheet" href="/_next/static/css/${f}">`)
  .join("\n");

function getShellHtml(title, activeNav, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title} — CareerMonke Admin</title>
  ${cssLinks}
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body class="font-sans antialiased text-[#09090B] bg-[#F8FAFC] min-h-screen flex flex-col selection:bg-blue-100 selection:text-blue-900 overflow-x-hidden w-full max-w-full">
  <div id="main-content" class="flex-1 flex flex-col">
    <!-- Admin Top Navigation Header -->
    <header class="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div class="flex items-center space-x-8">
          <div class="flex items-center space-x-3">
            <span class="font-extrabold text-lg tracking-tight text-slate-900">CareerMonke</span>
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700 uppercase tracking-wider">
              <svg class="w-3 h-3 text-red-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              Admin
            </span>
          </div>

          <nav class="flex space-x-1" aria-label="Admin Navigation">
            <a href="/admin" class="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeNav === "analytics" ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"}">
              <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 16v-4m5 4V8m5 8v-6"/></svg>
              Analytics
            </a>
            <a href="/admin/users" class="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeNav === "users" ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"}">
              <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Users
            </a>
            <a href="/admin/audit-log" class="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeNav === "audit-log" ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"}">
              <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path stroke-linecap="round" stroke-linejoin="round" d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
              Audit Log
            </a>
          </nav>
        </div>

        <div class="flex items-center space-x-4">
          <div class="hidden md:flex flex-col text-right">
            <span class="text-xs font-semibold text-slate-900">xbsuryakant@gmail.com</span>
            <span class="text-[10px] text-emerald-600 font-mono font-medium">Verified Admin</span>
          </div>
          <a href="/" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 transition-colors shadow-sm">
            <span>Exit to Site</span>
            <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </div>
      </div>
    </header>

    <!-- Main Admin Content Container -->
    <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
      ${bodyContent}
    </main>

    <!-- Admin Footer -->
    <footer class="border-t border-slate-200 bg-white py-4 text-center text-xs text-slate-500">
      CareerMonke Internal Admin Console • Restricted to xbsuryakant@gmail.com
    </footer>
  </div>
</body>
</html>`;
}

// 1. Users Page Content (with Server Pagination & Search Notice)
const usersPageBody = `
<div class="space-y-6">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
    <div>
      <h1 class="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
        <svg class="w-6 h-6 text-slate-700 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        User Management
      </h1>
      <p class="text-sm text-slate-500 mt-1">
        Search, review user activity, inspect Pro subscriptions, and manage block lists.
      </p>
    </div>
    <div class="flex items-center gap-2 self-start sm:self-auto">
      <button class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shadow-sm">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        <span>Refresh Users</span>
      </button>
    </div>
  </div>

  <!-- Controls: Search and Filters -->
  <div class="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
    <!-- Search Bar -->
    <div class="relative flex-1 max-w-md">
      <svg class="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="text" placeholder="Search users by email address..." value="alex" class="w-full pl-9 pr-20 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
      <button class="absolute right-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800">
        Search
      </button>
    </div>

    <!-- Filter Pills -->
    <div class="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm self-start">
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors bg-slate-900 text-white">All (120)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Pro (40)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Free (80)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Blocked (3)</button>
    </div>
  </div>

  <!-- Search Notice Banner -->
  <div class="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-center gap-2 shadow-sm">
    <svg class="w-4 h-4 text-amber-600 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <span>Global email search across unindexed auth users requires an elevated Postgres RPC function (locked in phase A1b). Search is currently applied to the requested server page.</span>
  </div>

  <!-- Users Table -->
  <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200">
          <tr>
            <th scope="col" class="px-5 py-3.5">User Email</th>
            <th scope="col" class="px-5 py-3.5">Signup Date</th>
            <th scope="col" class="px-5 py-3.5">Plan</th>
            <th scope="col" class="px-5 py-3.5">Last Active</th>
            <th scope="col" class="px-5 py-3.5 text-center">Page Views</th>
            <th scope="col" class="px-5 py-3.5">Status</th>
            <th scope="col" class="px-5 py-3.5 text-right">Moderation</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200">
          <!-- Row 1: Admin User -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5">
              <div class="font-semibold text-slate-900 flex items-center gap-2">
                <span>xbsuryakant@gmail.com</span>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 uppercase">Admin</span>
              </div>
              <div class="text-xs text-slate-400 font-mono mt-0.5">00000000-0000-0000-0000-000000000001</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Sep 1, 2026</td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                <svg class="w-3 h-3 text-amber-600" fill="currentColor" viewBox="0 0 24 24"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14v2H5v-2z"/></svg>
                Pro
              </span>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Oct 23, 2026</td>
            <td class="px-5 py-3.5 text-center">
              <button class="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md transition-colors" title="Click to view visited pages">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>84 views</span>
              </button>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Active
              </span>
            </td>
            <td class="px-5 py-3.5 text-right">
              <button disabled class="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-100 text-slate-400 cursor-not-allowed" title="Admin account cannot be blocked">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                <span>Admin Protected</span>
              </button>
            </td>
          </tr>

          <!-- Row 2: Pro Active User -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5">
              <div class="font-semibold text-slate-900">candidate.alex@careermonke.test</div>
              <div class="text-xs text-slate-400 font-mono mt-0.5">00000000-0000-0000-0000-000000000002</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Oct 15, 2026</td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                <svg class="w-3 h-3 text-amber-600" fill="currentColor" viewBox="0 0 24 24"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14v2H5v-2z"/></svg>
                Pro
              </span>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Oct 23, 2026</td>
            <td class="px-5 py-3.5 text-center">
              <button class="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md transition-colors" title="Click to view visited pages">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>32 views</span>
              </button>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Active
              </span>
            </td>
            <td class="px-5 py-3.5 text-right">
              <button class="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 transition-colors">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                <span>Block Account</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Server Pagination Controls -->
    <div class="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
      <div>
        Showing <span class="font-semibold text-slate-900">1</span> to <span class="font-semibold text-slate-900">25</span> of <span class="font-semibold text-slate-900">120</span> users
      </div>
      <div class="flex items-center gap-2">
        <button disabled class="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors">
          <svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>
          <span>Previous</span>
        </button>
        <span class="font-semibold text-slate-900 px-2">
          Page 1 of 5
        </span>
        <button class="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors">
          <span>Next</span>
          <svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>
`;

// 2. User Activity Modal Content
const userActivityModalHtml = `
<div class="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl max-w-2xl w-full shadow-2xl border border-slate-200 overflow-hidden transform transition-all">
    <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
      <div class="flex items-center space-x-3">
        <div class="p-2 bg-blue-100 text-blue-700 rounded-lg">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-900">User Activity Journey</h3>
          <p class="text-xs text-slate-500 font-mono mt-0.5">candidate.alex@careermonke.test</p>
        </div>
      </div>
      <button class="text-slate-400 hover:text-slate-600 transition-colors p-1">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="p-6 space-y-6">
      <div class="grid grid-cols-3 gap-4">
        <div class="p-3.5 bg-slate-50 rounded-xl border border-slate-200">
          <div class="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Past 24 Hours</div>
          <div class="text-xl font-extrabold text-slate-900 mt-1">12 views</div>
        </div>
        <div class="p-3.5 bg-slate-50 rounded-xl border border-slate-200">
          <div class="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Past 7 Days</div>
          <div class="text-xl font-extrabold text-slate-900 mt-1">32 views</div>
        </div>
        <div class="p-3.5 bg-slate-50 rounded-xl border border-slate-200">
          <div class="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Total Recorded</div>
          <div class="text-xl font-extrabold text-slate-900 mt-1">84 views</div>
        </div>
      </div>

      <div class="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 flex items-start gap-3">
        <svg class="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div class="text-xs text-amber-900 space-y-1">
          <div class="font-semibold text-amber-950">Telemetry Scope Notice</div>
          <p>Page views reflect navigations recorded in <code class="font-mono text-[11px] bg-amber-100 px-1 py-0.5 rounded">page_views</code>. Unindexed search terms, apply button outbound clicks, and direct AI generation calls are not yet collected as discrete events in the current schema.</p>
        </div>
      </div>
    </div>

    <div class="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end">
      <button class="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition-colors">
        Close
      </button>
    </div>
  </div>
</div>
`;

// Helper: Audit Log Page Generator
function getAuditLogBody({ state = "normal", errorText = null }) {
  return `
<div class="space-y-6">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
    <div>
      <div class="flex items-center gap-2">
        <h1 class="text-2xl font-bold text-slate-900 tracking-tight">Administrative Audit Log</h1>
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
          <svg class="w-3 h-3 text-slate-500 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Append-Only
        </span>
      </div>
      <p class="text-sm text-slate-500 mt-1">
        Chronological log of administrative actions, user moderations, and privileged operations.
      </p>
    </div>
    <div class="flex items-center gap-2 self-start sm:self-auto">
      <button class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shadow-sm">
        <svg class="w-3.5 h-3.5 ${state === "loading" ? "animate-spin" : ""}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        <span>Refresh</span>
      </button>
    </div>
  </div>

  <!-- Database Immutability & Protection Disclosure (Truthful text) -->
  <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 shadow-sm flex items-start gap-3">
    <div class="p-2 bg-blue-100 text-blue-700 rounded-lg shrink-0 mt-0.5">
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div class="text-xs text-slate-600 space-y-1">
      <div class="font-semibold text-slate-900">Database-Level Immutability Protection</div>
      <p class="leading-relaxed">
        Audit entries are designed as append-only via the PostgreSQL database trigger <code class="font-mono text-[11px] bg-slate-200/80 px-1 py-0.5 rounded text-slate-800">tr_prevent_admin_audit_log_mutation</code> defined in migration scripts to block <code class="font-mono text-[11px] bg-slate-200/80 px-1 py-0.5 rounded text-slate-800">UPDATE</code> and <code class="font-mono text-[11px] bg-slate-200/80 px-1 py-0.5 rounded text-slate-800">DELETE</code> operations. Live enforcement in production is pending database verification. This viewer provides read-only inspection with zero mutation controls.
      </p>
    </div>
  </div>

  ${
    errorText
      ? `
  <!-- Retryable Error Banner -->
  <div class="rounded-lg bg-red-50 p-4 border border-red-200 text-sm text-red-700 flex items-center justify-between shadow-sm">
    <div class="flex items-center gap-2">
      <svg class="w-5 h-5 text-red-600 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
      <span>${errorText}</span>
    </div>
    <button class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors shadow-sm">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      <span>Retry</span>
    </button>
  </div>`
      : ""
  }

  <!-- Action Filters -->
  <div class="flex items-center justify-between gap-4">
    <div class="inline-flex items-center gap-2">
      <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      <div class="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors bg-slate-900 text-white">All Actions</button>
        <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Blocks</button>
        <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Unblocks</button>
      </div>
    </div>
    <div class="text-xs text-slate-500 font-medium">
      ${state === "normal" ? "2 total logged events" : "0 logged events"}
    </div>
  </div>

  <!-- Audit Log Table -->
  <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200">
          <tr>
            <th scope="col" class="px-5 py-3.5">Timestamp</th>
            <th scope="col" class="px-5 py-3.5">Actor</th>
            <th scope="col" class="px-5 py-3.5">Action</th>
            <th scope="col" class="px-5 py-3.5">Target</th>
            <th scope="col" class="px-5 py-3.5">Reason / Details</th>
            <th scope="col" class="px-5 py-3.5 font-mono text-[11px]">Client IP Hash</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200 font-sans">
          ${
            state === "loading"
              ? `
          <tr>
            <td colSpan="6" class="px-5 py-12 text-center text-slate-400 text-sm">
              <div class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4 animate-spin text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                <span>Loading audit trail...</span>
              </div>
            </td>
          </tr>`
              : state === "empty"
              ? `
          <tr>
            <td colSpan="6" class="px-5 py-12 text-center text-slate-400 text-sm">
              No audit records found matching criteria.
            </td>
          </tr>`
              : state === "error"
              ? `
          <tr>
            <td colSpan="6" class="px-5 py-12 text-center text-slate-500 text-sm">
              <div class="flex flex-col items-center justify-center gap-2">
                <p class="text-red-600 font-medium">Failed to retrieve audit logs from database</p>
                <button class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 transition-colors shadow-sm">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  <span>Retry</span>
                </button>
              </div>
            </td>
          </tr>`
              : `
          <!-- Log 1: User Block -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">
              <div class="font-medium text-slate-900">Oct 23, 2026</div>
              <div class="text-[11px] text-slate-400 font-mono">19:40:00 UTC</div>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-100 text-slate-800">
                00000000...0001
              </span>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-red-50 text-red-700 border-red-200">
                <svg class="w-3 h-3 text-red-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                user.block
              </span>
            </td>
            <td class="px-5 py-3.5">
              <div class="font-medium text-slate-900 text-xs">bad-actor-001</div>
              <div class="text-[10px] text-slate-400 font-mono">user</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600 max-w-xs">
              <span class="text-slate-900 font-medium">Terms of service violation</span>
            </td>
            <td class="px-5 py-3.5 text-xs font-mono text-slate-500">
              <span title="abcdef1234567890abcdef1234567890">abcdef12...</span>
            </td>
          </tr>

          <!-- Log 2: User Unblock -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">
              <div class="font-medium text-slate-900">Oct 23, 2026</div>
              <div class="text-[11px] text-slate-400 font-mono">18:15:00 UTC</div>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-100 text-slate-800">
                00000000...0001
              </span>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                <svg class="w-3 h-3 text-emerald-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 11 12 14 22 4"/></svg>
                user.unblock
              </span>
            </td>
            <td class="px-5 py-3.5">
              <div class="font-medium text-slate-900 text-xs">reinstated-002</div>
              <div class="text-[10px] text-slate-400 font-mono">user</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600 max-w-xs">
              <span class="text-slate-900 font-medium">Appeal reviewed and approved</span>
            </td>
            <td class="px-5 py-3.5 text-xs font-mono text-slate-500">
              <span title="1234567890abcdef1234567890abcdef">12345678...</span>
            </td>
          </tr>`
          }
        </tbody>
      </table>
    </div>

    <!-- Pagination Footer -->
    <div class="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
      <div>
        ${
          state === "normal"
            ? `Showing <span class="font-semibold text-slate-900">1</span> to <span class="font-semibold text-slate-900">2</span> of <span class="font-semibold text-slate-900">2</span> entries`
            : `Showing <span class="font-semibold text-slate-900">0</span> entries`
        }
      </div>
      <div class="flex items-center gap-2">
        <span class="font-medium text-slate-700">Page 1 of 1</span>
        <div class="inline-flex rounded-md shadow-sm">
          <button disabled class="px-2.5 py-1 text-xs font-medium rounded-l-md border border-slate-200 bg-white text-slate-300 cursor-not-allowed">
            <svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>
            Previous
          </button>
          <button disabled class="px-2.5 py-1 text-xs font-medium rounded-r-md border border-l-0 border-slate-200 bg-white text-slate-300 cursor-not-allowed">
            Next
            <svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

// Start local static server to serve CSS and preview pages
const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  if (urlPath.startsWith("/_next/static/css/")) {
    const filename = path.basename(urlPath);
    const filePath = path.join(CSS_DIR, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/css" });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  if (urlPath === "/preview/users") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getShellHtml("User Management", "users", usersPageBody));
  }

  if (urlPath === "/preview/users-modal") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getShellHtml("User Management", "users", userActivityModalHtml));
  }

  if (urlPath === "/preview/audit-log") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getShellHtml("Administrative Audit Log", "audit-log", getAuditLogBody({ state: "normal" })));
  }

  if (urlPath === "/preview/audit-log-loading") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getShellHtml("Administrative Audit Log", "audit-log", getAuditLogBody({ state: "loading" })));
  }

  if (urlPath === "/preview/audit-log-empty") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getShellHtml("Administrative Audit Log", "audit-log", getAuditLogBody({ state: "empty" })));
  }

  if (urlPath === "/preview/audit-log-error") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      getShellHtml(
        "Administrative Audit Log",
        "audit-log",
        getAuditLogBody({ state: "error", errorText: "Failed to retrieve audit logs from database" })
      )
    );
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(3849, async () => {
  console.log("Screenshot preview server listening on port 3849...");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // 1. Desktop Users Page (1280x800)
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.goto("http://localhost:3849/preview/users", { waitUntil: "load" });
    const desktopUsersPath = path.join(REPORT_DIR, "admin-users-desktop.png");
    await page.screenshot({ path: desktopUsersPath, fullPage: true });
    console.log(`Saved screenshot: ${desktopUsersPath}`);

    // 2. Desktop User Activity Modal (1280x800)
    await page.goto("http://localhost:3849/preview/users-modal", { waitUntil: "load" });
    const desktopModalPath = path.join(REPORT_DIR, "admin-users-activity-modal-desktop.png");
    await page.screenshot({ path: desktopModalPath });
    console.log(`Saved screenshot: ${desktopModalPath}`);

    // 3. Desktop Audit Log - Normal (1280x800)
    await page.goto("http://localhost:3849/preview/audit-log", { waitUntil: "load" });
    const desktopAuditPath = path.join(REPORT_DIR, "admin-audit-log-desktop.png");
    await page.screenshot({ path: desktopAuditPath, fullPage: true });
    console.log(`Saved screenshot: ${desktopAuditPath}`);

    // 4. Desktop Audit Log - Loading (1280x800)
    await page.goto("http://localhost:3849/preview/audit-log-loading", { waitUntil: "load" });
    const desktopAuditLoadingPath = path.join(REPORT_DIR, "admin-audit-log-loading-desktop.png");
    await page.screenshot({ path: desktopAuditLoadingPath, fullPage: true });
    console.log(`Saved screenshot: ${desktopAuditLoadingPath}`);

    // 5. Desktop Audit Log - Empty (1280x800)
    await page.goto("http://localhost:3849/preview/audit-log-empty", { waitUntil: "load" });
    const desktopAuditEmptyPath = path.join(REPORT_DIR, "admin-audit-log-empty-desktop.png");
    await page.screenshot({ path: desktopAuditEmptyPath, fullPage: true });
    console.log(`Saved screenshot: ${desktopAuditEmptyPath}`);

    // 6. Desktop Audit Log - Error (1280x800)
    await page.goto("http://localhost:3849/preview/audit-log-error", { waitUntil: "load" });
    const desktopAuditErrorPath = path.join(REPORT_DIR, "admin-audit-log-error-desktop.png");
    await page.screenshot({ path: desktopAuditErrorPath, fullPage: true });
    console.log(`Saved screenshot: ${desktopAuditErrorPath}`);

    // 7. Mobile 390px Users Page (390x844)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto("http://localhost:3849/preview/users", { waitUntil: "load" });
    const mobileUsersPath = path.join(REPORT_DIR, "admin-users-mobile-390px.png");
    await page.screenshot({ path: mobileUsersPath, fullPage: true });
    console.log(`Saved screenshot: ${mobileUsersPath}`);

    // 8. Mobile 390px User Activity Modal (390x844)
    await page.goto("http://localhost:3849/preview/users-modal", { waitUntil: "load" });
    const mobileModalPath = path.join(REPORT_DIR, "admin-users-activity-modal-mobile-390px.png");
    await page.screenshot({ path: mobileModalPath });
    console.log(`Saved screenshot: ${mobileModalPath}`);

    // 9. Mobile 390px Audit Log - Normal (390x844)
    await page.goto("http://localhost:3849/preview/audit-log", { waitUntil: "load" });
    const mobileAuditPath = path.join(REPORT_DIR, "admin-audit-log-mobile-390px.png");
    await page.screenshot({ path: mobileAuditPath, fullPage: true });
    console.log(`Saved screenshot: ${mobileAuditPath}`);

    // 10. Mobile 390px Audit Log - Error (390x844)
    await page.goto("http://localhost:3849/preview/audit-log-error", { waitUntil: "load" });
    const mobileAuditErrorPath = path.join(REPORT_DIR, "admin-audit-log-error-mobile-390px.png");
    await page.screenshot({ path: mobileAuditErrorPath, fullPage: true });
    console.log(`Saved screenshot: ${mobileAuditErrorPath}`);

    console.log("All 10 mock screenshots captured successfully in reports/admin-a1/!");
  } finally {
    await browser.close();
    server.close();
  }
});
