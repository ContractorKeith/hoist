# Bun single-file executable

hoist ships as one Linux binary built with `bun build --compile`, using `bun:sqlite` for storage
and Bun's HTTP server for the dashboard. Chosen over Node 24 because the "one binary on one
server" promise is literal, SQLite needs no native module, and startup is fast enough to run
as the SSH forced command on every push. The cost is a smaller library pool: the Docker Engine
API and Caddy admin API are called directly over HTTP rather than through `dockerode`-style
wrappers, and git is the system `git`, installed by the installer.
