export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:",
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
