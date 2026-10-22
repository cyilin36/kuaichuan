/**
 * 传输控制：暂停/继续/停止按钮与发送循环里的暂停闸门。
 *
 * 页面只负责把动作转给当前传输控制器，具体失败/完成状态由控制器回写。
 */

export const CONTROL = {
  IDLE: 'idle',
  WAITING: 'waiting',
  RUNNING: 'running',
  PAUSING: 'pausing',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  DONE: 'done',
  ERROR: 'error',
};

export class TransferStoppedError extends Error {
  constructor() {
    super('传输已停止');
    this.name = 'TransferStoppedError';
    this.code = 'transfer_stopped';
  }
}

/** 发送循环用的暂停闸门：暂停时停在当前分片之后，停止时抛错退出 */
export class TransferGate {
  constructor() {
    this.paused = false;
    this.stopped = false;
    this.waiters = new Set();
  }

  pause() {
    if (this.stopped) return;
    this.paused = true;
  }

  resume() {
    if (this.stopped) return;
    this.paused = false;
    this.#wake();
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    this.#wake();
  }

  async wait() {
    if (this.stopped) throw new TransferStoppedError();
    while (this.paused) {
      await new Promise((resolve) => this.waiters.add(resolve));
      if (this.stopped) throw new TransferStoppedError();
    }
  }

  #wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

/**
 * 绑定页面上的两个按钮。
 *
 * @param {object} options
 * @param {HTMLElement} options.container 操作区容器
 * @param {HTMLButtonElement} options.pauseButton
 * @param {HTMLButtonElement} options.stopButton
 * @param {(action: 'pause'|'resume'|'stop') => void} options.onChange
 */
export function createTransferControls({ container, pauseButton, stopButton, onChange }) {
  let state = CONTROL.IDLE;
  let allowPause = true;

  const render = () => {
    const visible = ![CONTROL.IDLE, CONTROL.DONE, CONTROL.STOPPED, CONTROL.ERROR].includes(state);
    container.hidden = !visible;
    if (!visible) return;

    const canPause = allowPause && (state === CONTROL.RUNNING || state === CONTROL.PAUSED);
    pauseButton.hidden = !allowPause;
    pauseButton.disabled = !canPause;
    pauseButton.textContent = state === CONTROL.PAUSED
      ? '继续'
      : (state === CONTROL.PAUSING ? '正在暂停…' : '暂停');

    const canStop = state !== CONTROL.STOPPING;
    stopButton.hidden = false;
    stopButton.disabled = !canStop;
    stopButton.textContent = state === CONTROL.STOPPING ? '正在停止…' : '停止';
  };

  pauseButton.addEventListener('click', () => {
    if (state === CONTROL.RUNNING) onChange('pause');
    else if (state === CONTROL.PAUSED) onChange('resume');
  });

  stopButton.addEventListener('click', () => {
    if (state === CONTROL.STOPPING) return;
    if (state === CONTROL.WAITING || state === CONTROL.RUNNING
      || state === CONTROL.PAUSED || state === CONTROL.PAUSING) {
      onChange('stop');
    }
  });

  render();

  return {
    get state() {
      return state;
    },
    setState(next, options = {}) {
      state = next;
      if (options.allowPause !== undefined) allowPause = options.allowPause;
      render();
    },
    hide() {
      state = CONTROL.IDLE;
      render();
    },
  };
}
