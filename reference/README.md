# Reference material

`prototype-index.html` — the original static, single-file "Take Off Recruitment
Funnel" dashboard (Chart.js + d3, hardcoded data projected from BC4 files). It is
**not** part of the running app; it is preserved as the **data + visual
specification** for the production rebuild:

- It defines the tab/view hierarchy, the funnel stages, the metric registry
  (`ES_MET`), and the data shapes that the `gold_eba` / `silver_eba` BigQuery
  tables should back.
- When building or confirming a backend query or a frontend view, open this file
  to see what the original showed and which numbers were real vs illustrative.

Do not wire the app to this file — it is documentation.
