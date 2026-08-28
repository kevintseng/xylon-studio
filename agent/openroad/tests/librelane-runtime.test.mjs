import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '../..', '..')
const sandbox = path.join(repoRoot, 'runtime/librelane/bin/docker-sandbox')
const dockerShim = path.join(repoRoot, 'runtime/librelane/bin/docker')
const launcher = path.join(repoRoot, 'scripts/xylon-librelane')
const pinnedImage = 'ghcr.io/librelane/librelane@sha256:322b81f76d22053e5b92f9eaa6e4fb0440084fd02d77a4de0caa4ba7644c88c3'

function shimEnv(fakeDocker, temp) {
  return {
    ...process.env,
    XYLON_LIBRELANE_DOCKER_REAL: fakeDocker,
    XYLON_LIBRELANE_RUN_ID: 'run_12345678',
    XYLON_LIBRELANE_CIDFILE: path.join(temp, 'container.cid'),
  }
}

test('LibreLane Docker shim injects fixed resource and network limits', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'xylon-librelane-docker-'))
  const fakeDocker = path.join(temp, 'docker')
  const log = path.join(temp, 'args')
  await writeFile(fakeDocker, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\n`)
  await chmod(fakeDocker, 0o700)
  try {
    await execFileAsync('bash', [dockerShim, 'run', '--name', 'test', pinnedImage, 'command'], {
      env: shimEnv(fakeDocker, temp),
    })
    const args = await readFile(log, 'utf8')
    assert.match(args, /--platform linux\/arm64/)
    assert.match(args, /--cpus 1/)
    assert.match(args, /--memory 8g/)
    assert.match(args, /--network none/)
    assert.match(args, /--cidfile .*container\.cid/)
    assert.match(args, /--label io\.xylon\.owner=librelane/)
    assert.match(args, /--label io\.xylon\.run_id=run_12345678/)
    for (const override of ['--network', '--network=host', '--cpus=2', '--memory=16g', '--platform=linux/amd64', '--tmpfs=/tmp:rw']) {
      await assert.rejects(
        execFileAsync('bash', [dockerShim, 'run', override, pinnedImage, 'command'], {
          env: shimEnv(fakeDocker, temp),
        }),
        /resource\/security override is not allowed/,
      )
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('LibreLane Docker shim rejects an unpinned run image', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'xylon-librelane-docker-'))
  const fakeDocker = path.join(temp, 'docker')
  await writeFile(fakeDocker, '#!/usr/bin/env bash\nexit 99\n')
  await chmod(fakeDocker, 0o700)
  try {
    await assert.rejects(
      execFileAsync('bash', [dockerShim, 'run', '--name', 'test', 'evil/image:latest', 'command'], {
        env: shimEnv(fakeDocker, temp),
      }),
      /permits only the pinned LibreLane image/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('LibreLane Docker shim rejects non-run Docker verbs', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'xylon-librelane-docker-'))
  const fakeDocker = path.join(temp, 'docker')
  await writeFile(fakeDocker, '#!/usr/bin/env bash\nexit 99\n')
  await chmod(fakeDocker, 0o700)
  try {
    await assert.rejects(
      execFileAsync('bash', [dockerShim, 'ps'], {
        env: { ...process.env, XYLON_LIBRELANE_DOCKER_REAL: fakeDocker },
      }),
      /allows only bounded 'run' invocations/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('LibreLane Docker shim allows only exact read-only Docker probes', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'xylon-librelane-docker-'))
  const fakeDocker = path.join(temp, 'docker')
  const log = path.join(temp, 'args')
  await writeFile(fakeDocker, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\n`)
  await chmod(fakeDocker, 0o700)
  try {
    await execFileAsync('bash', [dockerShim, '--version'], {
      env: { ...process.env, XYLON_LIBRELANE_DOCKER_REAL: fakeDocker },
    })
    assert.equal(await readFile(log, 'utf8'), '--version\n')

    await execFileAsync('bash', [dockerShim, 'info', '--format', '{{json .}}'], {
      env: { ...process.env, XYLON_LIBRELANE_DOCKER_REAL: fakeDocker },
    })
    assert.equal(await readFile(log, 'utf8'), 'info --format {{json .}}\n')

    await execFileAsync('bash', [dockerShim, 'images', pinnedImage], {
      env: {
        ...process.env,
        XYLON_LIBRELANE_DOCKER_REAL: fakeDocker,
        LIBRELANE_IMAGE_OVERRIDE: pinnedImage,
      },
    })
    assert.equal(await readFile(log, 'utf8'), `image inspect ${pinnedImage}\n`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('LibreLane Docker shim rejects malformed read-only Docker probes', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'xylon-librelane-docker-'))
  const fakeDocker = path.join(temp, 'docker')
  await writeFile(fakeDocker, '#!/usr/bin/env bash\nexit 99\n')
  await chmod(fakeDocker, 0o700)
  try {
    await assert.rejects(
      execFileAsync('bash', [dockerShim, 'info'], {
        env: { ...process.env, XYLON_LIBRELANE_DOCKER_REAL: fakeDocker },
      }),
      /allows only 'docker info --format \{\{json \.\}\}'/,
    )
    await assert.rejects(
      execFileAsync('bash', [dockerShim, 'images', 'other-image'], {
        env: {
          ...process.env,
          XYLON_LIBRELANE_DOCKER_REAL: fakeDocker,
          LIBRELANE_IMAGE_OVERRIDE: pinnedImage,
        },
      }),
      /allows only 'docker images' for the pinned LibreLane image/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('LibreLane launcher documents a bounded run and fails before missing resources', async () => {
  const source = await readFile(launcher, 'utf8')
  assert.match(source, /LIBRELANE_IMAGE_OVERRIDE/)
  assert.match(source, /XYLON_LIBRELANE_PDK_ROOT/)
  assert.match(source, /\.xylon\/librelane\/venv\/bin\/python/)
  assert.match(source, /\.xylon\/librelane\/pdk/)
  assert.match(source, /local resource admission blocked LibreLane/)
  assert.match(source, /--docker-no-tty --pdk-root/)
  assert.match(source, /run directory must stay inside \.xylon\/timing\/runs/)
  assert.match(source, /runtime_bin.*PATH/)
  await readFile(dockerShim, 'utf8')
  assert.doesNotMatch(source, /realpath -e/)
})
