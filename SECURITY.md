# Security

Please don't open a public issue for security problems. Report them privately through
[GitHub private vulnerability reporting](https://github.com/GUMBOKIM/iphone-webkit-inspector/security/advisories/new).
Include what you found, how to reproduce it, and which version (`.claude-plugin/plugin.json`) you used.

What's in scope: the daemon and bridge sockets in `~/.cache/iphone-webkit-inspector/`, anything that lets a web page,
another local user, or another device reach the iPhone through this plugin, and anything the plugin sends or stores
that the README doesn't describe.

Bugs in pymobiledevice3 itself belong to [its project](https://github.com/doronz88/pymobiledevice3).
