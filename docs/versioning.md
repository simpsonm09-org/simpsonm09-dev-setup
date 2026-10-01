# Versioning and updates

Use current package-source versions by default. `windows/apps.json` leaves version pins unset. Existing installations are detected and preserved, not silently upgraded. Record observed versions for troubleshooting, but pin only for a concrete compatibility, security, or reproducibility reason and document that reason. Keep security-sensitive auto-updaters, especially Chrome, on their supported update channel rather than pinning them behind security fixes.

No setup script should move existing folders, overwrite personal configuration, install Windows containers, or enable a global AI configuration silently.
