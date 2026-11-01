# SSH is the only control plane

Apps and config are created and changed only through `git push` and CLI verbs that run on the
server behind an `authorized_keys` forced command. There is no HTTPS API and no token auth in
v1; the dashboard reads, and may roll back or restart, over a password session. Chosen over an
HTTPS API with tokens because the SSH key the owner already has for `git push` is the whole auth
story, which removes an auth layer from v1 and keeps no control port exposed. Reversing this
later means adding an API beside the CLI, not replacing it, so the CLI verbs must stay
transport-agnostic.
