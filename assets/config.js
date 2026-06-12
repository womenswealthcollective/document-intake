// Public Supabase config — SAFE to expose.
// The publishable/anon key is INSERT-ONLY by RLS policy: it can upload to the
// client-docs bucket and insert a submission row, but it cannot read, list,
// update, or delete anything. The service_role key is NEVER in this file or repo.
window.INTAKE_CONFIG = {
  SUPABASE_URL: "https://rylipdqmvibyctmsxity.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_NUK2o_Zy2ayf-RfwJQ1DYQ_4PsOxAFv",
  DOCS_BUCKET: "client-docs",
  LOGOS_BUCKET: "client-logos",
  // Firm-wide branding (your WWC logo lives in the repo at /assets/)
  FIRM_NAME: "Women's Wealth Collective",
  FIRM_LOGO: "/assets/logo-wwc-300-round.png",
  SITE_DOMAIN: "docs.womenswealthcollective360.com",
};
