type EventTargetWithListeners = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

type KnownEventTarget =
  | AbortSignal
  | Document
  | Element
  | HTMLElement
  | MediaQueryList
  | SVGElement
  | VisualViewport
  | Window;

type EventMap<Target> = Target extends Window
  ? WindowEventMap
  : Target extends Document
    ? DocumentEventMap
    : Target extends MediaQueryList
      ? MediaQueryListEventMap
      : Target extends VisualViewport
        ? VisualViewportEventMap
        : Target extends SVGElement
          ? SVGElementEventMap
          : Target extends HTMLElement
            ? HTMLElementEventMap
            : Target extends Element
              ? ElementEventMap & GlobalEventHandlersEventMap
              : Target extends AbortSignal
                ? AbortSignalEventMap
                : never;

type TypedEventListener<Target, Event> =
  { handleEvent(event: Event): void } | ((this: Target, event: Event) => void);

export interface ExtendedAddEventListenerOptions extends AddEventListenerOptions {
  /**
   * Timeout in milliseconds after which the event listener will automatically be removed.
   * Leverages native `AbortSignal.timeout` where available.
   */
  timeout?: number;
}

/**
 * Adds an event listener and returns a cleanup function to remove it.
 */
export function addEventListener<
  Target extends KnownEventTarget,
  Type extends keyof EventMap<Target>,
>(
  target: Target,
  type: Type,
  listener: TypedEventListener<Target, EventMap<Target>[Type]>,
  options?: boolean | ExtendedAddEventListenerOptions,
): () => void;
export function addEventListener(
  target: EventTargetWithListeners,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | ExtendedAddEventListenerOptions,
): () => void;
export function addEventListener(
  target: EventTargetWithListeners,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | ExtendedAddEventListenerOptions,
) {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let activeOptions = options;

  if (typeof options === 'object' && options !== null && typeof options.timeout === 'number') {
    const { timeout, signal, ...rest } = options;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const effectiveSignal = signal
        ? (typeof AbortSignal.any === 'function'
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal)
        : timeoutSignal;
      activeOptions = { ...rest, signal: effectiveSignal };
    } else {
      timerId = setTimeout(() => {
        cleanup();
      }, timeout);
    }
  }

  target.addEventListener(type, listener, activeOptions);

  function cleanup() {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
    target.removeEventListener(type, listener, activeOptions);
  }

  return cleanup;
}
