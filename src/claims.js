/* ═══════════════════════════════════════════════════════════════
   DMDS™ — claim registry
   Single source of truth for every quantitative claim on the page.
   The build fails if the page disagrees with this file or if a
   claim is past its review date (scripts/check.py). The loader's
   VERIFY claims step re-checks it at runtime in the visitor's DOM.

   Fields:
     page        exact string the page must display (data-claim wiring)
     dom         true → an element with data-claim="<id>" must exist
     text        the claim as worded on the page
     definition  precise meaning — what would make this true or false
     source      where the underlying fact lives
     verify      how a third party (or future maintainer) checks it
     verified    date the value was last confirmed (YYYY-MM-DD)
     review_by   build fails after this date until re-verified
     visibility  "public" (visitor-verifiable) | "attestable"
                 (privately verifiable — references on request)

   The JSON between the markers must stay strict JSON: the build
   check parses it.
   ═══════════════════════════════════════════════════════════════ */
window.DMDS_CLAIMS = /* claims-json-start */ {
  "version": "1.0.0",
  "updated": "2026-07-12",
  "owner": "Dennis Mink (@0xMink)",
  "claims": {
    "providers-routed": {
      "page": "20", "dom": true,
      "text": "20+ AI PROVIDERS ROUTED",
      "definition": "Distinct model providers routable through the Zoo Code AI gateway the operator maintains.",
      "source": "Zoo Code provider registry",
      "verify": "Count provider integrations in the Zoo Code repo settings UI or provider directory.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "platforms-production": {
      "page": "2", "dom": true,
      "text": "2 PLATFORMS IN PRODUCTION",
      "definition": "Zoo Code and insurewithmink.com — live or in active production use. The W-03 field-service platform (private engagement) is deliberately excluded: engineering/prototype work, not a completed production delivery (its dossier carries implementation metrics only). Restore to 3 only with owner verification of production use.",
      "source": "Live URLs",
      "verify": "Zoo Code and insurewithmink.com are publicly reachable.",
      "verified": "2026-08-03", "review_by": "2026-11-01", "visibility": "public"
    },
    "templates-used": {
      "page": "0", "dom": true,
      "text": "0 TEMPLATES USED",
      "definition": "No purchased or third-party page templates, themes, or site builders in any listed deliverable. Open-source libraries and scaffolding CLIs are not templates under this definition.",
      "source": "Project repositories",
      "verify": "Repo inspection — no theme/template packages in any dependency manifest.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "built-in-house": {
      "page": "100", "dom": true,
      "text": "100% BUILT IN-HOUSE",
      "definition": "All listed work authored by the operator. Excludes open-source dependencies, licensed typefaces, and platform services, which are disclosed where used.",
      "source": "Commit authorship",
      "verify": "git shortlog on project repositories.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "prs-authored": {
      "page": "34", "dom": true,
      "text": "34 PULL REQUESTS AUTHORED",
      "definition": "Pull requests authored by @0xMink across the Zoo Code and Roo Code organizations, any state.",
      "source": "GitHub",
      "verify": "GitHub search: is:pr author:0xMink org:Zoo-Code-Org org:RooCodeInc",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "prs-upstream": {
      "page": "12", "dom": true,
      "text": "12 MERGED INTO PUBLIC AI TOOLING",
      "definition": "Pull requests authored by @0xMink and merged into public AI-tooling repositories (Zoo Code and Roo Code).",
      "source": "GitHub",
      "verify": "GitHub search: is:pr is:merged author:0xMink",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "issues-triaged": {
      "page": "38", "dom": true,
      "text": "38 ISSUES FILED & TRIAGED",
      "definition": "GitHub issues filed by or triaged by @0xMink on public repositories.",
      "source": "GitHub",
      "verify": "GitHub search: is:issue involves:0xMink",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "operators": {
      "page": "1", "dom": true,
      "text": "1 PERSON. ZERO HANDOFFS.",
      "definition": "One engineer owns every engagement end to end — brief, build, and delivery. No account managers or subcontracted execution.",
      "source": "Studio structure",
      "verify": "Ask — the person who replies is the person who builds.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "zoo-stars": {
      "page": "1,266", "dom": true,
      "text": "1,266 GITHUB STARS",
      "definition": "Star count of Zoo-Code-Org/Zoo-Code at the verification date. Drifts daily; short review window on purpose.",
      "source": "https://github.com/Zoo-Code-Org/Zoo-Code",
      "verify": "Open the repo.",
      "verified": "2026-07-08", "review_by": "2026-09-08", "visibility": "public"
    },
    "zoo-prs-merged": {
      "page": "7", "dom": true,
      "text": "7 PRS MERGED",
      "definition": "PRs authored by @0xMink merged into Zoo-Code-Org/Zoo-Code.",
      "source": "https://github.com/Zoo-Code-Org/Zoo-Code/pulls",
      "verify": "GitHub search: repo:Zoo-Code-Org/Zoo-Code is:pr is:merged author:0xMink",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "zoo-prs-reviewed": {
      "page": "7", "dom": true,
      "text": "7 PRS REVIEWED",
      "definition": "PRs in Zoo-Code-Org/Zoo-Code reviewed by @0xMink as maintainer.",
      "source": "https://github.com/Zoo-Code-Org/Zoo-Code/pulls",
      "verify": "GitHub search: repo:Zoo-Code-Org/Zoo-Code is:pr reviewed-by:0xMink",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "zoo-loc-audited": {
      "page": "85,900", "dom": true,
      "text": "85,900 LOC AUDITED — POWER OF TEN",
      "definition": "Lines of production source covered by the NASA Power-of-Ten rules audit over Zoo Code (396 files).",
      "source": "Audit report in the Zoo Code engagement records",
      "verify": "Audit artifact on request; file count reproducible from the repo tree.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "zoo-files-audited": {
      "page": "396", "dom": false,
      "text": "…audit over all 396 production source files (dossier prose)",
      "definition": "Production source files in scope for the Power-of-Ten audit.",
      "source": "Audit report",
      "verify": "Reproducible from the repo tree at the audited commit.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "zoo-upstream-fixes": {
      "page": "5", "dom": false,
      "text": "Five fixes merged upstream into Roo Code itself (dossier prose)",
      "definition": "PRs authored by @0xMink merged into RooCodeInc/Roo-Code.",
      "source": "https://github.com/RooCodeInc/Roo-Code/pulls",
      "verify": "GitHub search: repo:RooCodeInc/Roo-Code is:pr is:merged author:0xMink",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "iwm-brand-systems": {
      "page": "1", "dom": true,
      "text": "1 BRAND SYSTEM",
      "definition": "Complete identity system shipped for Insure With Mink: logo, cards, print collateral, site.",
      "source": "insurewithmink.com + client records",
      "verify": "Live site; collateral on request.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "public"
    },
    "iwm-channels": {
      "page": "4", "dom": true,
      "text": "4 CHANNELS INSTRUMENTED",
      "definition": "Marketing channels with end-to-end measurement for Insure With Mink (site, search, social content, email).",
      "source": "Client engagement records",
      "verify": "References on request.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "iwm-compliance": {
      "page": "100%", "dom": true,
      "text": "100% COMPLIANCE-GATED CONTENT",
      "definition": "Every published marketing asset for the insurance practice passed a human compliance review before shipping.",
      "source": "Content calendar + review log",
      "verify": "Review log on request.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "iwm-t65": {
      "page": "T-65", "dom": true,
      "text": "T-65 CAMPAIGN OPS SPEC",
      "definition": "Medicare turning-65 campaign operations specification — designer and ops briefs, on file.",
      "source": "Client engagement records",
      "verify": "Spec on request.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "w03-commits": {
      "page": "412", "dom": true,
      "text": "412 COMMITS, SOLE ENGINEER",
      "definition": "Commits in the W-03 field-service platform repository (private engagement), all authored by the operator, at the verification date.",
      "source": "Private repository",
      "verify": "References on request — private engagement.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "w03-proverif": {
      "page": "4", "dom": true,
      "text": "4 PROVERIF MODELS",
      "definition": "ProVerif models with machine-checked results in the W-03 platform repo (ratchet forward secrecy, capability chain, and supporting models).",
      "source": "Private repository",
      "verify": "Model files and prover output on request.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "w03-tla": {
      "page": "3", "dom": true,
      "text": "3 TLA+ SPECS, MODEL-CHECKED",
      "definition": "TLA+ specifications with TLC traces on file (ForwardSecretRatchet, CellMigration, SchemaCoordinator).",
      "source": "Private repository",
      "verify": "Specs and TLC output on request.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "w03-platforms": {
      "page": "2", "dom": true,
      "text": "2 PLATFORMS — RUST + REACT NATIVE",
      "definition": "Rust backend plus a React Native customer app.",
      "source": "Private repository",
      "verify": "References on request.",
      "verified": "2026-07-08", "review_by": "2026-10-08", "visibility": "attestable"
    },
    "particle-budget": {
      "page": "262,144", "dom": false,
      "text": "262,144 particles simulated (loader + console report the actual seeded count)",
      "definition": "Tier-1 desktop budget: the WebGL2 GPGPU engine simulates 262,144 particles (a 512² state texture); mobile and save-data contexts seed 65,536 (256²). The WebGL1 fallback tier seeds 42,000 / 16,000. The boot log and console print the count actually seeded at runtime, not this constant.",
      "source": "src/gl2.js N; src/gl.js COUNT",
      "verify": "Read the source; watch the boot log.",
      "verified": "2026-07-17", "review_by": "2027-07-17", "visibility": "public"
    },
    "draw-calls": {
      "page": "1", "dom": false,
      "text": "1 draw call (console)",
      "definition": "The particle field itself renders in a single GL_POINTS draw call in both engine tiers. Tier 1 adds one MRT simulation pass per frame, and the desktop post pipeline adds four fullscreen-quad passes; those are the dominant fill-rate cost, and this claim does not pretend otherwise.",
      "source": "src/gl2.js frame(); src/gl.js frame()",
      "verify": "Read the source or capture a frame in a GPU debugger.",
      "verified": "2026-07-17", "review_by": "2027-07-17", "visibility": "public"
    },
    "external-requests": {
      "page": "0", "dom": false,
      "text": "0 external requests (console + footer)",
      "definition": "Zero network requests during initial page load — fonts, styles, scripts, and favicon are inline. A configured lead endpoint makes one HTTPS POST on form submission; submitting is an explicit visitor action, not page load.",
      "source": "dist/index.html",
      "verify": "DevTools network panel on load.",
      "verified": "2026-07-12", "review_by": "2027-07-12", "visibility": "public"
    }
  }
} /* claims-json-end */;
