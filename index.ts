import mimicFn from 'mimic-fn';
import type {AsyncReturnType} from 'type-fest';

// TODO: Use the one in `type-fest` when it's added there.
export type AnyAsyncFunction = (...arguments_: readonly any[]) => Promise<unknown | void>;

const cacheStore = new WeakMap<AnyAsyncFunction, CacheStorage<any, any> | false>();

export interface CacheStorage<KeyType, ValueType> {
	has: (key: KeyType) => Promise<boolean> | boolean;
	get: (key: KeyType) => Promise<ValueType | undefined> | ValueType | undefined;
	set: (key: KeyType, value: ValueType) => Promise<unknown> | unknown;
	delete: (key: KeyType) => unknown;
	clear?: () => unknown;
}

export interface Options<
	FunctionToMemoize extends AnyAsyncFunction,
	CacheKeyType,
> {
	/**
	Determines the cache key for storing the result based on the function arguments. By default, __only the first argument is considered__ and it only works with [primitives](https://developer.mozilla.org/en-US/docs/Glossary/Primitive).

	A `cacheKey` function can return any type supported by `Map` (or whatever structure you use in the `cache` option).

	You can have it cache **all** the arguments by value with `JSON.stringify`, if they are compatible:

	```
	import pMemoize from 'p-memoize';

	pMemoize(function_, {cacheKey: JSON.stringify});
	```

	Or you can use a more full-featured serializer like [serialize-javascript](https://github.com/yahoo/serialize-javascript) to add support for `RegExp`, `Date` and so on.

	```
	import pMemoize from 'p-memoize';
	import serializeJavascript from 'serialize-javascript';

	pMemoize(function_, {cacheKey: serializeJavascript});
	```

	@default arguments_ => arguments_[0]
	@example arguments_ => JSON.stringify(arguments_)
	*/
	readonly cacheKey?: (arguments_: Parameters<FunctionToMemoize>) => CacheKeyType;

	/**
	Use a different cache storage. Must implement the following methods: `.has(key)`, `.get(key)`, `.set(key, value)`, `.delete(key)`, and optionally `.clear()`. You could for example use a `WeakMap` instead or [`quick-lru`](https://github.com/sindresorhus/quick-lru) for a LRU cache. To disable caching so that only concurrent executions resolve with the same value, pass `false`.

	@default new Map()
	@example new WeakMap()
	*/
	readonly cache?: CacheStorage<CacheKeyType, AsyncReturnType<FunctionToMemoize>> | false;
}

/**
[Memoize](https://en.wikipedia.org/wiki/Memoization) functions - An optimization used to speed up consecutive function calls by caching the result of calls with identical input.

@param fn - Function to be memoized.

@example
```
import {setTimeout as delay} from 'node:timer/promises';
import pMemoize from 'p-memoize';
import got from 'got';

const memoizedGot = pMemoize(got);

await memoizedGot('https://sindresorhus.com');

// This call is cached
await memoizedGot('https://sindresorhus.com');

await delay(2000);

// This call is not cached as the cache has expired
await memoizedGot('https://sindresorhus.com');
```
*/
export default function pMemoize<
	FunctionToMemoize extends AnyAsyncFunction,
	CacheKeyType,
>(
	fn: FunctionToMemoize,
	{
		cacheKey = ([firstArgument]) => firstArgument as CacheKeyType,
		cache = new Map<CacheKeyType, AsyncReturnType<FunctionToMemoize>>(),
	}: Options<FunctionToMemoize, CacheKeyType> = {},
): FunctionToMemoize {
	// Promise objects can't be serialized so we keep track of them internally and only provide their resolved values to `cache`
	// `Promise<AsyncReturnType<FunctionToMemoize>>` is used instead of `ReturnType<FunctionToMemoize>` because promise properties are not kept
	const promiseCache = new Map<CacheKeyType, Promise<AsyncReturnType<FunctionToMemoize>>>();

	const memoized = function (this: any, ...arguments_: Parameters<FunctionToMemoize>): Promise<AsyncReturnType<FunctionToMemoize>> { // eslint-disable-line @typescript-eslint/promise-function-async
		const key = cacheKey(arguments_);

		if (promiseCache.has(key)) {
			return promiseCache.get(key)!;
		}

		const promise = (async () => {
			try {
				if (cache && await cache.has(key)) {
					return (await cache.get(key))!;
				}

				const promise = fn.apply(this, arguments_) as Promise<AsyncReturnType<FunctionToMemoize>>;

				const result = await promise;

				try {
					return result;
				} finally {
					if (cache) {
						await cache.set(key, result);
					}
				}
			} finally {
				promiseCache.delete(key);
			}
		})();

		promiseCache.set(key, promise);

		return promise;
	} as FunctionToMemoize;

	mimicFn(memoized, fn, {
		ignoreNonConfigurable: true,
	});

	cacheStore.set(memoized, cache);

	return memoized;
}

/**
- Only class methods and getters/setters can be memoized, not regular functions (they aren't part of the proposal);
- Only [TypeScript’s decorators](https://www.typescriptlang.org/docs/handbook/decorators.html#parameter-decorators) are supported, not [Babel’s](https://babeljs.io/docs/en/babel-plugin-proposal-decorators), which use a different version of the proposal;
- Being an experimental feature, they need to be enabled with `--experimentalDecorators`; follow TypeScript’s docs.

@returns A [decorator](https://github.com/tc39/proposal-decorators) to memoize class methods or static class methods.

@example
```
import {pMemoizeDecorator} from 'p-memoize';

class Example {
	index = 0

	@pMemoizeDecorator()
	async counter() {
		return ++this.index;
	}
}

class ExampleWithOptions {
	index = 0

	@pMemoizeDecorator()
	async counter() {
		return ++this.index;
	}
}
```
*/
export function pMemoizeDecorator<
	FunctionToMemoize extends AnyAsyncFunction,
	CacheKeyType,
>(
	options: Options<FunctionToMemoize, CacheKeyType> = {},
) {
	const instanceMap = new WeakMap();

	return (
		target: any,
		propertyKey: string,
		descriptor: PropertyDescriptor,
	): void => {
		const input = target[propertyKey]; // eslint-disable-line @typescript-eslint/no-unsafe-assignment

		if (typeof input !== 'function') {
			throw new TypeError('The decorated value must be a function');
		}

		delete descriptor.value;
		delete descriptor.writable;

		descriptor.get = function () {
			if (!instanceMap.has(this)) {
				const value = pMemoize(input, options) as FunctionToMemoize;
				instanceMap.set(this, value);
				return value;
			}

			return instanceMap.get(this) as FunctionToMemoize;
		};
	};
}

/**
Clear all cached data of a memoized function.

@param fn - Memoized function.
*/
export function pMemoizeClear(fn: AnyAsyncFunction): void {
	if (!cacheStore.has(fn)) {
		throw new TypeError('Can\'t clear a function that was not memoized!');
	}

	const cache = cacheStore.get(fn);

	if (!cache) {
		throw new TypeError('Can\'t clear a function that doesn\'t use a cache!');
	}

	if (typeof cache.clear !== 'function') {
		throw new TypeError('The cache Map can\'t be cleared!');
	}

	cache.clear();
}
