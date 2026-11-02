import js from "./static/dashboard.js" with { type: "text" };
import htmx from "./static/htmx.min.js" with { type: "text" };
import css from "./static/style.css" with { type: "text" };

export const assets: Record<string, [string, string]> = {
  "/static/htmx.min.js": [htmx, "text/javascript"],
  "/static/style.css": [css, "text/css"],
  "/static/dashboard.js": [js, "text/javascript"],
};
