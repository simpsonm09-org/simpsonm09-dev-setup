// Render the per-platform artifacts from a parsed tools.yaml manifest.
// scripts/tools.mjs owns the CLI, validation, and the install plan.

function toolWindowsSection(tool) {
  return tool.windows ?? null;
}

function renderWindowsApps(manifest) {
  const apps = [];
  for (const tool of manifest.tools) {
    const section = toolWindowsSection(tool);
    if (!section || (section.manager !== 'winget' && section.manager !== 'msstore')) continue;
    if (typeof section.id !== 'string' || section.id === '') continue;
    const entry = {
      name: section.name ?? tool.name,
      id: section.id,
      source: section.manager,
      role: tool.role,
      installByDefault: section.installByDefault ?? tool.installByDefault ?? true,
    };
    if (section.requiresExplicitOptIn ?? tool.requiresExplicitOptIn) entry.requiresExplicitOptIn = true;
    entry.version = section.version ?? null;
    entry.versionPolicy = section.policy ?? tool.policy ?? 'latest';
    if (Array.isArray(section.installedAliases)) entry.installedAliases = section.installedAliases;
    apps.push(entry);
  }
  return apps;
}

function renderWindowsManual(manifest) {
  const apps = [];
  for (const tool of manifest.tools) {
    const section = toolWindowsSection(tool);
    if (!section || section.manager !== 'manual' || tool.kind !== 'app') continue;
    apps.push({
      name: section.name ?? tool.name,
      publisher: section.publisher ?? tool.name,
      source: section.url,
      role: tool.role,
      observedVersion: section.observedVersion ?? null,
      installPolicy: section.installPolicy ?? 'manual-official-release',
    });
  }
  return apps;
}

export function sectionPackages(section) {
  if (Array.isArray(section.packages) && section.packages.length > 0) return section.packages;
  return [section.package];
}

function isDeferred(tool, section) {
  const optIn = section.requiresExplicitOptIn ?? tool.requiresExplicitOptIn;
  const byDefault = section.installByDefault ?? tool.installByDefault ?? true;
  return Boolean(optIn) || byDefault === false;
}

function renderWslPackages(manifest) {
  const aptPackages = [];
  const optionalAptProfiles = {};
  const snapPackages = [];
  const npmPackages = [];
  const manualTools = {};
  const deferredTools = [];
  for (const tool of manifest.tools) {
    const section = tool.wsl;
    if (!section) continue;
    if (isDeferred(tool, section)) {
      deferredTools.push({ id: tool.id, label: installLabel(section) });
    } else if (section.manager === 'apt' && !section.profile) {
      aptPackages.push(...sectionPackages(section));
    } else if (section.manager === 'snap') {
      for (const pkg of sectionPackages(section)) {
        snapPackages.push({ id: tool.id, package: pkg, classic: section.classic ?? false });
      }
    } else if (section.manager === 'npm') {
      for (const pkg of sectionPackages(section)) npmPackages.push({ id: tool.id, package: pkg });
    } else if (section.manager === 'manual') {
      manualTools[tool.id] = {
        url: section.url ?? null,
        note: section.note ?? null,
        observedVersion: section.observedVersion ?? null,
        updateCommand: section.updateCommand ?? null,
        managedByBootstrap: section.managedByBootstrap ?? false,
      };
    }
    // A profiled apt section, like dockerEngine, is installed by its own script
    // and never enters the default apt list.
    if (section.manager === 'apt' && section.profile) {
      (optionalAptProfiles[section.profile] ??= []).push(...sectionPackages(section));
    }
  }
  const data = { ubuntuRelease: manifest.ubuntuRelease, aptPackages };
  if (Object.keys(optionalAptProfiles).length > 0) data.optionalAptProfiles = optionalAptProfiles;
  if (snapPackages.length > 0) data.snapPackages = snapPackages;
  if (npmPackages.length > 0) data.npmPackages = npmPackages;
  data.packagePolicy = manifest.packagePolicy;
  data.manualTools = manualTools;
  if (deferredTools.length > 0) data.deferredTools = deferredTools;
  return data;
}

function renderBrewfile(manifest) {
  const lines = ['# Generated from tools.yaml by scripts/tools.mjs. Do not edit by hand.'];
  for (const tool of manifest.tools) {
    const section = tool.macos;
    if (!section || section.manager !== 'brew') continue;
    const entry = section.formula ? `brew "${section.formula}"` : `cask "${section.cask}"`;
    // An opt-in or non-default tool stays commented out, so `brew bundle` never
    // installs it. The note tells the reader how to install it deliberately.
    if (isDeferred(tool, section)) {
      lines.push(`# opt-in: ${entry}${tool.note ? ` ${tool.note}` : ''}`);
      continue;
    }
    lines.push(entry);
  }
  return `${lines.join('\n')}\n`;
}

function renderPlan(manifest) {
  return `${JSON.stringify({ generatedBy: 'scripts/tools.mjs', ...manifest }, null, 2)}\n`;
}

export function installLabel(section) {
  const packages = Array.isArray(section.packages) ? section.packages.join(', ') : section.package;
  switch (section.manager) {
    case 'winget': return `winget \`${section.id}\``;
    case 'msstore': return `msstore \`${section.id}\``;
    case 'scoop': return `scoop \`${packages}\``;
    case 'apt': return `apt \`${packages}\``;
    case 'snap': return `snap \`${packages}${section.classic ? ' --classic' : ''}\``;
    case 'npm': return `npm \`${packages}\``;
    case 'brew': return section.formula ? `brew \`${section.formula}\`` : `cask \`${section.cask}\``;
    case 'manual': return section.url ? `manual (${section.url})` : 'manual';
    default: return section.manager;
  }
}

function platformInstall(tool) {
  const platforms = ['windows', 'wsl', 'macos'];
  return platforms
    .filter((platform) => tool[platform])
    .map((platform) => `${platform}: ${installLabel(tool[platform])}`)
    .join('; ');
}

function renderDocs(manifest) {
  const rows = (kind, header) => {
    const lines = [`| ${header} | Role | Install |`, '| --- | --- | --- |'];
    for (const tool of manifest.tools) {
      if (tool.kind !== kind) continue;
      const equivalents = Array.isArray(tool.equivalents) ? tool.equivalents.join(', ') : '';
      const role = equivalents ? `${tool.role} (equivalents: ${equivalents})` : tool.role;
      lines.push(`| ${tool.name} | ${role} | ${platformInstall(tool)} |`);
    }
    return lines.join('\n');
  };
  return `# Apps and roles

Generated from [\`../tools.yaml\`](../tools.yaml). Do not edit this file by hand; edit
\`tools.yaml\` and run \`just tools-render\`. The Windows list also lands in
[\`../windows/apps.json\`](../windows/apps.json) and
[\`../windows/manual-apps.json\`](../windows/manual-apps.json), the WSL list in
[\`../wsl/packages.json\`](../wsl/packages.json), and the macOS list in
[\`../Brewfile\`](../Brewfile).

## Apps

${rows('app', 'App')}

## Developer CLI tools

${rows('cli', 'Tool')}

## Installation-source policy

Prefer package managers. winget is the first choice for Windows apps, apt and snap for
WSL packages, and brew for macOS. Scoop is the approved Windows fallback when winget has
no entry. Use an official publisher installer only when no supported package manager
entry exists, and never an unofficial mirror. Microsoft Store apps need interactive
review of their terms, so the apply scripts leave them for a manual install. Existing
installations are detected and left unchanged; a version pin applies only to a new
install.

The host and shell plans agree on the action set: the tool id, the manager, and the
action. Whether a tool is already present is a per-host convenience, so the Node plan
on the host and the shell plan on the target may report \`present\` versus \`install\`
for the same tool.
`;
}

export function renderArtifacts(manifest) {
  return {
    'Brewfile': renderBrewfile(manifest),
    'windows/apps.json': `${JSON.stringify(renderWindowsApps(manifest), null, 2)}\n`,
    'windows/manual-apps.json': `${JSON.stringify(renderWindowsManual(manifest), null, 2)}\n`,
    'wsl/packages.json': `${JSON.stringify(renderWslPackages(manifest), null, 2)}\n`,
    'tools.generated.json': renderPlan(manifest),
    'docs/apps.md': renderDocs(manifest),
  };
}
