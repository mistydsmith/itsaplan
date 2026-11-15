// sentinel-prod-8429 setup row 7: the address the api binds. Pure, no database and no listener.
import { describe, expect, it } from 'bun:test';
import { listenOptions } from '../../listen-options';

describe('listenOptions', () => {
  it('keeps the old bind when API_HOST is unset: the port alone, every interface', () => {
    expect(listenOptions({})).toEqual({ port: 3000 });
    expect(listenOptions({ API_PORT: '3210' })).toEqual({ port: 3210 });
  });

  it('binds only the address API_HOST names', () => {
    expect(listenOptions({ API_PORT: '3210', API_HOST: '127.0.0.1' })).toEqual({
      port: 3210,
      hostname: '127.0.0.1',
    });
    expect(listenOptions({ API_HOST: ' ::1 ' })).toEqual({ port: 3000, hostname: '::1' });
  });

  it('refuses a blank API_HOST instead of binding every interface', () => {
    expect(() => listenOptions({ API_HOST: '' })).toThrow('API_HOST is set but empty');
    expect(() => listenOptions({ API_HOST: '   ' })).toThrow('API_HOST is set but empty');
  });
});
