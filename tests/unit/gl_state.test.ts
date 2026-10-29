import { describe, expect, it } from 'vitest';
import { GlStateGuard, RepaintScheduler, watchContextLoss } from '../../src/render/gl_state';
import { FakeGl } from './helpers/fake_gl';

describe('GlStateGuard (#50 M5.7)', () => {
  it('restores everything the render touched and the debug diff is empty', () => {
    const gl = new FakeGl();
    gl.enable(gl.STENCIL_TEST); gl.stencilFunc(0x0202, 3, 0xf0);
    const guard = new GlStateGuard(gl as never, { debug: true });
    const diff = guard.run(() => {
      gl.enable(gl.BLEND); gl.blendFunc(0x302, 0x303); gl.enable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
      gl.useProgram({}); gl.bindVertexArray({}); gl.bindBuffer(gl.ARRAY_BUFFER, 9); gl.viewport(1, 2, 3, 4);
      gl.colorMask(false, true, false, true); gl.depthMask(false); gl.activeTexture(0x84c3); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(5, 5, 5, 5); gl.stencilFunc(0x0200, 1, 1);
    });
    expect(diff).toEqual([]);
    expect(gl.isEnabled(gl.BLEND)).toBe(false);
    expect(gl.isEnabled(gl.STENCIL_TEST)).toBe(true);
    expect(gl.getParameter(gl.STENCIL_REF)).toBe(3);
    expect(gl.getParameter(gl.VIEWPORT)).toEqual([0, 0, 300, 150]);
  });

  it('a mutation that leaves BLEND enabled turns the debug check red', () => {
    const gl = new FakeGl();
    const guard = new GlStateGuard(gl as never, { debug: true, skip: ['blend'] });
    const diff = guard.run(() => gl.enable(gl.BLEND));
    expect(diff.map((d) => d.name)).toContain('BLEND');
  });
});

describe('context loss and repaint (#50 M5.7)', () => {
  it('drops handles on loss, rebuilds on restore, then repaints', () => {
    const t = new EventTarget();
    const log: string[] = [];
    watchContextLoss(t as never, { onLost: () => log.push('lost'), onRestored: () => log.push('restored'), repaint: () => log.push('repaint') });
    const ev = new Event('webglcontextlost', { cancelable: true });
    t.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    t.dispatchEvent(new Event('webglcontextrestored'));
    expect(log).toEqual(['lost', 'restored', 'repaint']);
  });

  it('idle: no repaint is triggered unless work is pending', () => {
    let n = 0;
    let pending = 0;
    const s = new RepaintScheduler(() => { n++; }, () => pending);
    for (let i = 0; i < 300; i++) s.afterRender();
    expect(n).toBe(0);
    pending = 2; s.afterRender(); s.afterRender();
    expect(n).toBe(2);
  });
});
