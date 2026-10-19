// Type-level proof that the live `src/extension` types still accept what an
// extension written against the frozen `v1.d.ts` does. Checked by
// `bun run check:extension-api`; nothing here runs.
//
// Direction matters. What the engine hands an extension (a host) may grow:
// live ⊆-assignable to frozen. What an extension hands the engine (an action,
// a job, a query, an expect) must still be accepted: frozen assignable to live.

import type * as Live from '../src/extension/index.js';
import { ActionRefusal as LiveRefusal, todayIn as liveTodayIn } from '../src/extension/index.js';
import type * as V1 from './v1.js';

type Assignable<From, To> = [From] extends [To] ? true : false;
const ok = <T extends true>(): T => true as T;

// TypeScript compares method parameters bivariantly, so a host method that
// grew a required argument still "assigns". Check each method both ways by hand:
// v1 arguments must still be accepted, live results must still satisfy v1.
// biome-ignore lint/suspicious/noExplicitAny: matching any function shape
type Fn = (...args: any[]) => any;
type MethodsCompat<L, F> = {
  [K in keyof F]: K extends keyof L
    ? F[K] extends Fn
      ? L[K] extends Fn
        ? Assignable<Parameters<F[K]>, Parameters<L[K]>> extends true
          ? Assignable<ReturnType<L[K]>, ReturnType<F[K]>>
          : false
        : false
      : true
    : false;
}[keyof F];

// Hosts: the engine provides at least what v1 promised.
ok<Assignable<Live.ActionHost, V1.ActionHost>>();
ok<Assignable<Live.JobHost, V1.JobHost>>();
ok<Assignable<Live.HostCollections, V1.HostCollections>>();
ok<MethodsCompat<Live.HostCollections, V1.HostCollections>>();
ok<MethodsCompat<Live.ActionHost, V1.ActionHost>>();

// Extension-provided values: v1 ones still type-check against live.
ok<Assignable<V1.ExtensionAction, Live.ExtensionAction>>();
ok<Assignable<V1.ExtensionJob, Live.ExtensionJob>>();
ok<Assignable<V1.DataApiReadQuery, Live.DataApiReadQuery>>();
ok<Assignable<V1.UpdateExpect, Live.UpdateExpect>>();
ok<Assignable<V1.RefusalStatus, Live.RefusalStatus>>();
ok<Assignable<V1.ZveltioExtensionV1['actions'], Live.ZveltioExtension['actions']>>();
ok<Assignable<V1.ZveltioExtensionV1['jobs'], Live.ZveltioExtension['jobs']>>();

// Runtime exports keep their v1 call signatures.
// (Not the classes whole: each `unique symbol` is its own type. The engine
// matches the refusal by `Symbol.for` key, which `action-refusal.test.ts` pins.)
ok<
  Assignable<
    ConstructorParameters<typeof V1.ActionRefusal>,
    ConstructorParameters<typeof LiveRefusal>
  >
>();
ok<
  Assignable<
    Pick<LiveRefusal, 'status' | 'code' | 'message'>,
    Pick<V1.ActionRefusal, 'status' | 'code' | 'message'>
  >
>();
ok<Assignable<typeof liveTodayIn, typeof V1.todayIn>>();
