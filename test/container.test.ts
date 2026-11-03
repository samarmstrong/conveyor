import { describe, expect, it } from 'vitest';
import { agentLayer, containerName, execArgs, homeOf, parseEnvironment, staleImages } from '../src/container.ts';

describe('parseEnvironment', () => {
  it("reads the Dockerfile against .cursor/, the user, install and start, as Cursor does", () => {
    const env = parseEnvironment(JSON.stringify({ build: { dockerfile: 'Dockerfile' }, user: 'ubuntu', install: 'npm ci', start: 'make up' }));
    expect(env).toEqual({ dockerfile: '.cursor/Dockerfile', user: 'ubuntu', install: 'npm ci', start: 'make up' });
    expect(parseEnvironment(JSON.stringify({ build: { dockerfile: '../docker/agent.Dockerfile' } })).dockerfile).toBe('docker/agent.Dockerfile');
  });

  it('runs as root, with nothing to install or start, when it says nothing', () => {
    expect(parseEnvironment('{}')).toEqual({ dockerfile: null, user: 'root', install: null, start: null });
  });
});

describe('agentLayer', () => {
  it('adds gh and the host\'s Claude Code version on top of the environment, for its user', () => {
    const layer = agentLayer('factory-env:abc', 'ubuntu', '2.1.303');
    expect(layer).toMatch(/^FROM factory-env:abc\n/);
    expect(layer).toContain('install -y --no-install-recommends gh');
    expect(layer).toContain('bash -s 2.1.303');
    expect(layer).toContain('ENV PATH=/home/ubuntu/.local/bin:$PATH');
    expect(layer).toContain('s/"fuse-overlayfs"/"overlay2"/');
    expect(homeOf('root')).toBe('/root');
  });
});

describe('execArgs', () => {
  it('passes secrets by name, never by value, and stdin only when asked', () => {
    expect(execArgs('factory-abcdef12', 'ubuntu', '/home/ubuntu/r', ['CLAUDE_CODE_OAUTH_TOKEN'], ['claude', '-p'], true))
      .toEqual(['exec', '-i', '-u', 'ubuntu', '-w', '/home/ubuntu/r', '-e', 'CLAUDE_CODE_OAUTH_TOKEN', 'factory-abcdef12', 'claude', '-p']);
    expect(execArgs('c', 'root', null, [], ['true'])).toEqual(['exec', '-u', 'root', 'c', 'true']);
  });

  it('names a container after its session', () => {
    expect(containerName('0b33598a-48f9-407c-9318-885045e8de56')).toBe('factory-0b33598a');
  });
});

describe('staleImages', () => {
  it('is every factory image but the ones in use, and nothing else on the machine', () => {
    const tags = ['factory-env:aaa', 'factory-env:bbb', 'factory-agent:ccc', 'factory-agent:ddd', 'postgres:16', 'factory-7b0cffb0-soc-daemon:latest'];
    expect(staleImages(tags, ['factory-env:bbb', 'factory-agent:ddd'])).toEqual(['factory-env:aaa', 'factory-agent:ccc']);
  });
});
