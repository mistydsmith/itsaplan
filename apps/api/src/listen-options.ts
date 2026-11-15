// Where the api listens, read from the server's own environment.
//
// WHY this exists (sentinel-prod-8429 setup row 7): index.ts used to call app.listen(port) with no
// hostname, and Bun then binds every interface. On a host that also sits on a private network
// (a tailnet, an office LAN) that publishes the api to every machine on it. An operator who runs
// the api outside a container needs to name the address, for example API_HOST=127.0.0.1.
//
// WHY unset keeps the old behavior: the compose files publish the container's port 3000 to the
// host, and that only works while the api binds every interface inside the container. Making
// loopback the default here would break every container install on its next upgrade.
//
// WHY a set but blank API_HOST throws instead of falling back: a blank value is an operator who
// meant to restrict the bind and mistyped it. Falling back to every interface would do the
// opposite of what they asked, without a word in the log.

export interface ListenOptions {
  port: number;
  hostname?: string;
}

type ListenEnv = Readonly<Record<string, string | undefined>>;

export function listenOptions(env: ListenEnv): ListenOptions {
  const port = Number(env.API_PORT ?? 3000);
  const host = env.API_HOST;
  if (host === undefined) return { port };
  const hostname = host.trim();
  if (hostname === '') {
    throw new Error(
      'API_HOST is set but empty: name the address to bind (for example 127.0.0.1), or unset it to bind every interface.',
    );
  }
  return { port, hostname };
}
