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

// 1. Users Page Content
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
      <input type="text" placeholder="Search users by email address..." value="" class="w-full pl-9 pr-20 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
      <button class="absolute right-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800">
        Search
      </button>
    </div>

    <!-- Filter Pills -->
    <div class="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm self-start">
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors bg-slate-900 text-white">All (4)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Pro (2)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Free (2)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">Blocked (1)</button>
    </div>
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
              <div class="text-xs text-slate-400 font-mono mt-0.5">usr-001</div>
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
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
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
              <div class="font-semibold text-slate-900">debasrita@careermonke.com</div>
              <div class="text-xs text-slate-400 font-mono mt-0.5">usr-002</div>
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
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
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

          <!-- Row 3: Free Active User -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5">
              <div class="font-semibold text-slate-900">candidate.alex@outlook.com</div>
              <div class="text-xs text-slate-400 font-mono mt-0.5">usr-003</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Oct 18, 2026</td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">Free</span>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Oct 22, 2026</td>
            <td class="px-5 py-3.5 text-center">
              <button class="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md transition-colors" title="Click to view visited pages">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>14 views</span>
              </button>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
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

          <!-- Row 4: Blocked User -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5">
              <div class="font-semibold text-slate-900">spammer.bot99@tempmail.org</div>
              <div class="text-xs text-slate-400 font-mono mt-0.5">usr-004</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Oct 20, 2026</td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">Free</span>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600">Oct 20, 2026</td>
            <td class="px-5 py-3.5 text-center">
              <button class="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md transition-colors" title="Click to view visited pages">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>3 views</span>
              </button>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                Blocked
              </span>
            </td>
            <td class="px-5 py-3.5 text-right">
              <button class="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 11 12 14 22 4"/></svg>
                <span>Unblock Account</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Bounded Pagination Footer -->
    <div class="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
      <div>
        Showing <span class="font-semibold text-slate-900">1</span> to <span class="font-semibold text-slate-900">4</span> of <span class="font-semibold text-slate-900">4</span> users
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
</div>
`;

// 2. User Activity Modal Content (on top of users page)
const userActivityModalHtml = `
${usersPageBody}
<!-- Modal Overlay Backdrop -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
  <div class="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden my-auto">
    <!-- Modal Header -->
    <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
      <div>
        <h3 class="font-bold text-base text-slate-900 flex items-center gap-2">
          <svg class="w-5 h-5 text-blue-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          User Activity: debasrita@careermonke.com
        </h3>
        <p class="text-xs text-slate-500 mt-0.5">Recent page views and activity telemetry</p>
      </div>
      <button class="text-slate-400 hover:text-slate-600 transition-colors p-1" aria-label="Close dialog">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <!-- Modal Scrollable Content -->
    <div class="p-6 overflow-y-auto space-y-6">
      <!-- 24h and 7d Usage Summary Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="p-3.5 bg-blue-50/60 rounded-xl border border-blue-100">
          <div class="text-[11px] font-semibold text-blue-900 uppercase tracking-wider flex items-center gap-1">
            <svg class="w-3.5 h-3.5 text-blue-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            24h Activity
          </div>
          <div class="text-xl font-bold text-blue-950 mt-1">3 <span class="text-xs font-normal text-blue-700">views</span></div>
          <p class="text-[10px] text-blue-700 mt-0.5">Recorded page views</p>
        </div>

        <div class="p-3.5 bg-indigo-50/60 rounded-xl border border-indigo-100">
          <div class="text-[11px] font-semibold text-indigo-900 uppercase tracking-wider flex items-center gap-1">
            <svg class="w-3.5 h-3.5 text-indigo-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            7d Activity
          </div>
          <div class="text-xl font-bold text-indigo-950 mt-1">5 <span class="text-xs font-normal text-indigo-700">views</span></div>
          <p class="text-[10px] text-indigo-700 mt-0.5">Recorded page views</p>
        </div>

        <div class="p-3.5 bg-slate-50 rounded-xl border border-slate-200">
          <div class="text-[11px] font-semibold text-slate-700 uppercase tracking-wider flex items-center gap-1">
            <svg class="w-3.5 h-3.5 text-slate-500 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            Total Recorded
          </div>
          <div class="text-xl font-bold text-slate-900 mt-1">32 <span class="text-xs font-normal text-slate-500">views</span></div>
          <p class="text-[10px] text-slate-500 mt-0.5">Lifetime page views</p>
        </div>
      </div>

      <!-- Telemetry Disclosure Notice Banner -->
      <div class="p-3.5 bg-amber-50 rounded-xl border border-amber-200 flex items-start gap-2.5">
        <svg class="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div class="text-xs text-amber-900 leading-relaxed">
          <strong class="font-semibold text-amber-950">Telemetry Notice:</strong> Current database schema tracks page views only. Per-user search queries, job apply clicks, and AI prompt requests are not yet recorded per user in the database schema. Automated abuse controls and suspension rules will be implemented in subsequent phases.
        </div>
      </div>

      <!-- Visited Pages List -->
      <div>
        <h4 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2.5">Recorded Page Views (Latest First)</h4>
        <div class="border border-slate-200 rounded-lg overflow-hidden">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
              <tr>
                <th class="px-3.5 py-2">Path</th>
                <th class="px-3.5 py-2">Referrer</th>
                <th class="px-3.5 py-2 text-right">Time</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr class="hover:bg-slate-50/50">
                <td class="px-3.5 py-2 font-mono text-blue-600 font-medium">/jobs</td>
                <td class="px-3.5 py-2 text-slate-500 truncate max-w-xs">https://google.com</td>
                <td class="px-3.5 py-2 text-right text-slate-500">Oct 23, 2026, 6:30:00 PM</td>
              </tr>
              <tr class="hover:bg-slate-50/50">
                <td class="px-3.5 py-2 font-mono text-blue-600 font-medium">/dashboard</td>
                <td class="px-3.5 py-2 text-slate-400 italic">Direct / None</td>
                <td class="px-3.5 py-2 text-right text-slate-500">Oct 23, 2026, 6:32:00 PM</td>
              </tr>
              <tr class="hover:bg-slate-50/50">
                <td class="px-3.5 py-2 font-mono text-blue-600 font-medium">/tracker</td>
                <td class="px-3.5 py-2 text-slate-400 italic">Direct / None</td>
                <td class="px-3.5 py-2 text-right text-slate-500">Oct 23, 2026, 6:35:00 PM</td>
              </tr>
              <tr class="hover:bg-slate-50/50">
                <td class="px-3.5 py-2 font-mono text-blue-600 font-medium">/settings</td>
                <td class="px-3.5 py-2 text-slate-400 italic">Direct / None</td>
                <td class="px-3.5 py-2 text-right text-slate-500">Oct 22, 2026, 2:10:00 PM</td>
              </tr>
              <tr class="hover:bg-slate-50/50">
                <td class="px-3.5 py-2 font-mono text-blue-600 font-medium">/pricing</td>
                <td class="px-3.5 py-2 text-slate-400 italic">Direct / None</td>
                <td class="px-3.5 py-2 text-right text-slate-500">Oct 21, 2026, 9:00:00 AM</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Modal Footer -->
    <div class="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end">
      <button class="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition-colors">
        Close
      </button>
    </div>
  </div>
</div>
`;

// 3. Audit Log Page Content
const auditLogPageBody = `
<div class="space-y-6">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
    <div>
      <h1 class="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
        <svg class="w-6 h-6 text-slate-700 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path stroke-linecap="round" stroke-linejoin="round" d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
        System Audit Log
      </h1>
      <p class="text-sm text-slate-500 mt-1">
        Immutable, tamper-evident log of administrative operations and access events.
      </p>
    </div>
    <div class="flex items-center gap-2 self-start sm:self-auto">
      <button class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shadow-sm">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        <span>Refresh Logs</span>
      </button>
    </div>
  </div>

  <!-- Immutability Security Callout -->
  <div class="rounded-xl border border-blue-200 bg-blue-50/70 p-4 flex items-start gap-3">
    <svg class="w-5 h-5 text-blue-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    <div class="text-xs text-blue-900 leading-relaxed">
      <span class="font-semibold text-blue-950">Database Trigger Hardened:</span> Audit records are immutable. Direct row updates, deletions, and truncations are blocked at the PostgreSQL engine level via trigger <code class="bg-blue-100/80 px-1 py-0.5 rounded font-mono text-[11px] text-blue-900 font-semibold">tr_prevent_admin_audit_log_mutation</code>. No edit or delete controls exist in this administrative console.
    </div>
  </div>

  <!-- Action Filters -->
  <div class="flex items-center gap-2 overflow-x-auto pb-1">
    <div class="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors bg-slate-900 text-white">All Actions (3)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">user.block (1)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">user.unblock (1)</button>
      <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors text-slate-600 hover:text-slate-900">security.policy_update (1)</button>
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
            <th scope="col" class="px-5 py-3.5">Reason / Metadata</th>
            <th scope="col" class="px-5 py-3.5 font-mono">IP Hash</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200 font-sans">
          <!-- Log 1: User Block -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">
              <div class="font-medium text-slate-900">Oct 23, 2026</div>
              <div class="text-[11px] text-slate-400">7:40:00 PM</div>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-100 text-slate-800">
                usr-001
              </span>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-red-50 text-red-700 border-red-200">
                <svg class="w-3 h-3 text-red-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                user.block
              </span>
            </td>
            <td class="px-5 py-3.5">
              <div class="font-medium text-slate-900 text-xs">spammer.bot99@tempmail.org</div>
              <div class="text-[10px] text-slate-400 font-mono">user</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600 max-w-xs">
              <span class="text-slate-900 font-medium">Automated scraping and terms abuse</span>
            </td>
            <td class="px-5 py-3.5 text-xs font-mono text-slate-500">
              <span title="9b3c4f28e6a1d827c5e9b04f32187654">9b3c4f28e6a1...</span>
            </td>
          </tr>

          <!-- Log 2: User Unblock -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">
              <div class="font-medium text-slate-900">Oct 23, 2026</div>
              <div class="text-[11px] text-slate-400">6:15:00 PM</div>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-100 text-slate-800">
                usr-001
              </span>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                <svg class="w-3 h-3 text-emerald-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 11 12 14 22 4"/></svg>
                user.unblock
              </span>
            </td>
            <td class="px-5 py-3.5">
              <div class="font-medium text-slate-900 text-xs">candidate.alex@outlook.com</div>
              <div class="text-[10px] text-slate-400 font-mono">user</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600 max-w-xs">
              <span class="text-slate-900 font-medium">Manual appeal review completed</span>
            </td>
            <td class="px-5 py-3.5 text-xs font-mono text-slate-500">
              <span title="9b3c4f28e6a1d827c5e9b04f32187654">9b3c4f28e6a1...</span>
            </td>
          </tr>

          <!-- Log 3: Security Policy Update -->
          <tr class="hover:bg-slate-50/75 transition-colors">
            <td class="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">
              <div class="font-medium text-slate-900">Oct 22, 2026</div>
              <div class="text-[11px] text-slate-400">11:00:00 AM</div>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-100 text-slate-800">
                usr-001
              </span>
            </td>
            <td class="px-5 py-3.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-blue-50 text-blue-700 border-blue-200">
                <svg class="w-3 h-3 text-blue-600 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                security.policy_update
              </span>
            </td>
            <td class="px-5 py-3.5">
              <div class="font-medium text-slate-900 text-xs">auth-guard</div>
              <div class="text-[10px] text-slate-400 font-mono">system</div>
            </td>
            <td class="px-5 py-3.5 text-xs text-slate-600 max-w-xs">
              <span class="text-slate-900 font-medium">Enforce strict IP hashing and session timeout</span>
            </td>
            <td class="px-5 py-3.5 text-xs font-mono text-slate-500">
              <span title="a4f810c9d7e5b3210987654321fedcba">a4f810c9d7e5...</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Bounded Pagination Footer -->
    <div class="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
      <div>
        Showing <span class="font-semibold text-slate-900">1</span> to <span class="font-semibold text-slate-900">3</span> of <span class="font-semibold text-slate-900">3</span> entries
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
</div>
`;

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
    return res.end(getShellHtml("System Audit Log", "audit-log", auditLogPageBody));
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
    const page = await browser.newPage();

    // 1. Desktop Users Page (1280x800)
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.goto("http://localhost:3849/preview/users", { waitUntil: "networkidle2" });
    const desktopUsersPath = path.join(REPORT_DIR, "admin-users-desktop.png");
    await page.screenshot({ path: desktopUsersPath, fullPage: true });
    console.log(`Saved screenshot: ${desktopUsersPath}`);

    // 2. Desktop User Activity Modal (1280x800)
    await page.goto("http://localhost:3849/preview/users-modal", { waitUntil: "networkidle2" });
    const desktopModalPath = path.join(REPORT_DIR, "admin-users-activity-modal-desktop.png");
    await page.screenshot({ path: desktopModalPath });
    console.log(`Saved screenshot: ${desktopModalPath}`);

    // 3. Desktop Audit Log (1280x800)
    await page.goto("http://localhost:3849/preview/audit-log", { waitUntil: "networkidle2" });
    const desktopAuditPath = path.join(REPORT_DIR, "admin-audit-log-desktop.png");
    await page.screenshot({ path: desktopAuditPath, fullPage: true });
    console.log(`Saved screenshot: ${desktopAuditPath}`);

    // 4. Mobile 390px Users Page (390x844)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto("http://localhost:3849/preview/users", { waitUntil: "networkidle2" });
    const mobileUsersPath = path.join(REPORT_DIR, "admin-users-mobile-390px.png");
    await page.screenshot({ path: mobileUsersPath, fullPage: true });
    console.log(`Saved screenshot: ${mobileUsersPath}`);

    // 5. Mobile 390px User Activity Modal (390x844)
    await page.goto("http://localhost:3849/preview/users-modal", { waitUntil: "networkidle2" });
    const mobileModalPath = path.join(REPORT_DIR, "admin-users-activity-modal-mobile-390px.png");
    await page.screenshot({ path: mobileModalPath });
    console.log(`Saved screenshot: ${mobileModalPath}`);

    // 6. Mobile 390px Audit Log (390x844)
    await page.goto("http://localhost:3849/preview/audit-log", { waitUntil: "networkidle2" });
    const mobileAuditPath = path.join(REPORT_DIR, "admin-audit-log-mobile-390px.png");
    await page.screenshot({ path: mobileAuditPath, fullPage: true });
    console.log(`Saved screenshot: ${mobileAuditPath}`);

    console.log("All 6 screenshots captured successfully!");
  } finally {
    await browser.close();
    server.close();
  }
});
