import { escapeHTML, page } from "./templates";
export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
export const html = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
export const redirect = (location: string, headers: HeadersInit = {}) =>
  new Response(null, {
    status: 303,
    headers: { Location: location, ...headers },
  });

export const errorPage = (
  message: string,
  status: number,
  token?: string,
  back = "/",
) =>
  html(
    page(message, `<p><a href="${escapeHTML(back)}">Back</a></p>`, token),
    status,
  );

export function withSecurityHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(securityHeaders))
    if (!response.headers.has(key)) response.headers.set(key, value);
  return response;
}
