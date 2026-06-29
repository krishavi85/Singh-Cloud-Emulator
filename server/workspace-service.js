const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(process.env.WORKSPACE_ROOT || path.join(__dirname, '..', 'data', 'workspaces'));
const maxFileBytes = Math.max(1024, Number(process.env.WORKSPACE_FILE_LIMIT_BYTES || 2 * 1024 * 1024));

function safeSegment(value, name = 'value') {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(text)) throw Object.assign(new Error(`Invalid ${name}.`), { status: 400 });
  return text;
}

function workspaceDir(userId, workspaceId) {
  return path.join(root, safeSegment(userId, 'user id'), safeSegment(workspaceId, 'workspace id'));
}

function resolveFile(userId, workspaceId, relativePath) {
  const base = workspaceDir(userId, workspaceId);
  const raw = String(relativePath || '').replace(/\\/g, '/');
  const segments = raw.split('/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || segments.includes('..') || segments.includes('')) {
    throw Object.assign(new Error('Invalid workspace path.'), { status: 400 });
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw Object.assign(new Error('Invalid workspace path.'), { status: 400 });
  }
  const resolved = path.resolve(base, normalized);
  if (!resolved.startsWith(`${path.resolve(base)}${path.sep}`)) {
    throw Object.assign(new Error('Workspace path escapes its sandbox.'), { status: 400 });
  }
  return { base, resolved, normalized };
}

async function createWorkspaceFiles(userId, workspaceId) {
  const base = workspaceDir(userId, workspaceId);
  await fs.mkdir(path.join(base, 'app', 'src', 'main', 'java', 'com', 'singh', 'cloudapp'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(base, 'app', 'src', 'main', 'res', 'values'), { recursive: true, mode: 0o700 });
  const files = {
    'settings.gradle.kts': 'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = "CloudApp"\ninclude(":app")\n',
    'build.gradle.kts': 'plugins { id("com.android.application") version "8.7.3" apply false; id("org.jetbrains.kotlin.android") version "2.0.21" apply false }\n',
    'app/build.gradle.kts': 'plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }\n\nandroid { namespace = "com.singh.cloudapp"; compileSdk = 35\n    defaultConfig { applicationId = "com.singh.cloudapp"; minSdk = 24; targetSdk = 35; versionCode = 1; versionName = "1.0" }\n}\n\ndependencies { implementation("androidx.core:core-ktx:1.15.0"); implementation("androidx.appcompat:appcompat:1.7.0") }\n',
    'app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:theme="@style/AppTheme" android:label="Cloud App"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>\n',
    'app/src/main/java/com/singh/cloudapp/MainActivity.kt': 'package com.singh.cloudapp\n\nimport android.os.Bundle\nimport android.widget.TextView\nimport androidx.appcompat.app.AppCompatActivity\n\nclass MainActivity : AppCompatActivity() {\n    override fun onCreate(savedInstanceState: Bundle?) {\n        super.onCreate(savedInstanceState)\n        setContentView(TextView(this).apply { text = "Hello from Singh Cloud Emulator"; textSize = 22f })\n    }\n}\n',
    'app/src/main/res/values/styles.xml': '<resources><style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar"/></resources>\n',
    '.gitignore': '.gradle/\n.idea/\nlocal.properties\nbuild/\n**/build/\n*.jks\n*.keystore\n'
  };
  await Promise.all(Object.entries(files).map(async ([relative, content]) => {
    const target = path.join(base, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  }));
}

async function listFiles(userId, workspaceId) {
  const base = workspaceDir(userId, workspaceId);
  const results = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.gradle' || entry.name === 'build') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else results.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  await walk(base);
  return results.sort();
}

async function readFile(userId, workspaceId, relativePath) {
  const { resolved } = resolveFile(userId, workspaceId, relativePath);
  const stat = await fs.stat(resolved);
  if (stat.size > maxFileBytes) throw Object.assign(new Error('Workspace file is too large to open in the editor.'), { status: 413 });
  return fs.readFile(resolved, 'utf8');
}

async function writeFile(userId, workspaceId, relativePath, content) {
  const value = String(content ?? '');
  if (Buffer.byteLength(value, 'utf8') > maxFileBytes) throw Object.assign(new Error('Workspace file exceeds the editor limit.'), { status: 413 });
  const { resolved } = resolveFile(userId, workspaceId, relativePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fs.writeFile(resolved, value, { encoding: 'utf8', mode: 0o600 });
  return true;
}

async function deleteWorkspace(userId, workspaceId) {
  await fs.rm(workspaceDir(userId, workspaceId), { recursive: true, force: true });
}

module.exports = { createWorkspaceFiles, deleteWorkspace, listFiles, readFile, resolveFile, root, workspaceDir, writeFile };
