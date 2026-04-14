const os = require('os');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const util = require('util');
const net = require('net');

let si, pty, WebSocket, fetchImpl;

si = require('systeminformation');
pty = require('node-pty');
WebSocket = require('ws');

if (typeof globalThis.fetch === 'function') {
  fetchImpl = globalThis.fetch;
} else {
  const nodeFetch = require('node-fetch');
  fetchImpl = nodeFetch.default || nodeFetch;
}

const execAsync = util.promisify(exec);
const VERSION = 'komari-agent-nodejs-1.1.2-mossbox';

class Logger {
  constructor(onLine, level = 0) {
    this.onLine = typeof onLine === 'function' ? onLine : () => {};
    this.level = Number(level || 0);
  }

  setLevel(level) {
    this.level = Number(level || 0);
  }

  line(message, level = 'INFO') {
    if (this.level === 0 && level !== 'ERROR') return;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    this.onLine(logMessage);
    if (level === 'ERROR') this.onLine(logMessage);
  }

  debug(message, debugLevel = 1) {
    if (this.level === debugLevel) this.line(message, 'DEBUG');
  }

  info(message) { this.line(message, 'INFO'); }
  warning(message) { this.line(message, 'WARNING'); }
  error(message) { this.line(message, 'ERROR'); }
}

class SystemInfoCollector {
  constructor(logger) {
    this.logger = logger;
    this.lastNetworkStats = { rx: 0, tx: 0 };
    this.totalNetworkUp = 0;
    this.totalNetworkDown = 0;
    this.lastNetworkTime = Date.now();
    this._cpuInitialized = false;
    this._lastCpuUsage = null;
  }

  async getBasicInfo() {
    const [osInfo, cpuInfo, memInfo, diskInfo] = await Promise.all([
      si.osInfo(),
      si.cpu(),
      si.mem(),
      si.fsSize()
    ]);

    const [ipv4, ipv6] = await Promise.all([
      this._getPublicIpV4().catch(() => null),
      this._getPublicIpV6().catch(() => null)
    ]);

    const osName = osInfo.distro && osInfo.distro !== 'unknown'
      ? `${osInfo.distro} ${osInfo.release}`
      : os.type();

    const totalDisk = diskInfo.reduce((sum, disk) => sum + (disk.size || 0), 0);

    return {
      arch: os.arch(),
      cpu_cores: cpuInfo.cores || os.cpus().length,
      cpu_name: cpuInfo.brand || 'Unknown CPU',
      disk_total: totalDisk,
      gpu_name: '',
      ipv4,
      ipv6,
      mem_total: memInfo.total || os.totalmem(),
      os: osName,
      kernel_version: osInfo.kernel || os.release(),
      swap_total: memInfo.swaptotal || 0,
      version: VERSION,
      virtualization: await this._getVirtualization()
    };
  }

  async getRealtimeInfo() {
    const [cpuUsage, memInfo, diskInfo, networkStats, processes] = await Promise.all([
      this._getCpuUsage(),
      si.mem(),
      si.fsSize(),
      this._getNetworkStats(),
      si.processes().catch(() => ({ all: 0 }))
    ]);

    const loadavg = os.loadavg();
    const diskTotal = diskInfo.reduce((sum, disk) => sum + (disk.size || 0), 0);
    const diskUsed = diskInfo.reduce((sum, disk) => sum + (disk.used || 0), 0);

    const [tcpConns, udpConns] = await Promise.all([
      this._getTcpConnections().catch(() => 0),
      this._getUdpConnections().catch(() => 0)
    ]);

    return {
      cpu: { usage: cpuUsage },
      ram: { total: memInfo.total || os.totalmem(), used: memInfo.used || (memInfo.total - memInfo.free) },
      swap: { total: memInfo.swaptotal || 0, used: memInfo.swapused || 0 },
      load: {
        load1: Math.round(loadavg[0] * 100) / 100,
        load5: Math.round(loadavg[1] * 100) / 100,
        load15: Math.round(loadavg[2] * 100) / 100
      },
      disk: { total: diskTotal, used: diskUsed },
      network: {
        up: networkStats.up,
        down: networkStats.down,
        totalUp: networkStats.total_up,
        totalDown: networkStats.total_down
      },
      connections: { tcp: tcpConns, udp: udpConns },
      uptime: Math.floor(os.uptime()),
      process: processes.all || 0,
      message: ''
    };
  }

  async _getCpuUsage() {
    if (!this._cpuInitialized) {
      this._lastCpuUsage = process.cpuUsage();
      await new Promise(resolve => setTimeout(resolve, 100));
      this._cpuInitialized = true;
      return 0.0;
    }

    const currentLoad = await si.currentLoad().catch(() => null);
    if (currentLoad && typeof currentLoad.currentLoad === 'number') {
      return Math.round(currentLoad.currentLoad * 100) / 100;
    }

    const newUsage = process.cpuUsage(this._lastCpuUsage);
    this._lastCpuUsage = process.cpuUsage();
    const totalUsage = (newUsage.user + newUsage.system) / 1000;
    const percentage = Math.min(100, Math.max(0, totalUsage / 10));
    return Math.round(percentage * 100) / 100;
  }

  async _getNetworkStats() {
    try {
      const networkStats = await si.networkStats();
      const currentTime = Date.now();
      let totalCurrentRx = 0;
      let totalCurrentTx = 0;
      const excludePatterns = ['lo', 'docker', 'veth', 'br-', 'tun', 'virbr', 'vmnet'];

      for (const iface of networkStats) {
        if (excludePatterns.some(pattern => iface.iface && iface.iface.includes(pattern))) continue;
        totalCurrentRx += iface.rx_bytes || 0;
        totalCurrentTx += iface.tx_bytes || 0;
      }

      if (this.lastNetworkStats.rx === 0) {
        this.totalNetworkDown = totalCurrentRx;
        this.totalNetworkUp = totalCurrentTx;
        this.lastNetworkStats = { rx: totalCurrentRx, tx: totalCurrentTx };
        this.lastNetworkTime = currentTime;
        return { up: 0, down: 0, total_up: this.totalNetworkUp, total_down: this.totalNetworkDown };
      }

      const timeDiff = (currentTime - this.lastNetworkTime) / 1000;
      let downSpeed = 0;
      let upSpeed = 0;
      if (timeDiff > 0) {
        downSpeed = Math.max(0, (totalCurrentRx - this.lastNetworkStats.rx) / timeDiff);
        upSpeed = Math.max(0, (totalCurrentTx - this.lastNetworkStats.tx) / timeDiff);
      }

      this.totalNetworkDown = totalCurrentRx;
      this.totalNetworkUp = totalCurrentTx;
      this.lastNetworkStats = { rx: totalCurrentRx, tx: totalCurrentTx };
      this.lastNetworkTime = currentTime;

      return {
        up: Math.floor(upSpeed),
        down: Math.floor(downSpeed),
        total_up: this.totalNetworkUp,
        total_down: this.totalNetworkDown
      };
    } catch {
      return { up: 0, down: 0, total_up: 0, total_down: 0 };
    }
  }

  async _getTcpConnections() {
    const connections = await si.networkConnections();
    return connections.filter(conn => conn.protocol === 'tcp' && conn.state === 'ESTABLISHED').length;
  }

  async _getUdpConnections() {
    const connections = await si.networkConnections();
    return connections.filter(conn => conn.protocol === 'udp').length;
  }

  async _getVirtualization() {
    try {
      const systemInfo = await si.system();
      if (systemInfo.virtual) return systemInfo.virtualHost || 'Unknown';
      if (fs.existsSync('/.dockerenv')) return 'Docker';
      return 'None';
    } catch {
      return 'None';
    }
  }

  async _getPublicIpV4() {
    const services = ['https://api.ipify.org', 'https://icanhazip.com', 'https://checkip.amazonaws.com', 'https://ifconfig.me/ip'];
    for (const service of services) {
      try {
        const response = await fetchImpl(service, { headers: { 'User-Agent': VERSION } });
        if (response.ok) {
          const ip = (await response.text()).trim();
          if (this._isValidIpv4(ip)) return ip;
        }
      } catch {}
    }
    return null;
  }

  async _getPublicIpV6() {
    const services = ['https://api6.ipify.org', 'https://icanhazip.com'];
    for (const service of services) {
      try {
        const response = await fetchImpl(service, { headers: { 'User-Agent': VERSION } });
        if (response.ok) {
          const ip = (await response.text()).trim();
          if (this._isValidIpv6(ip)) return ip;
        }
      } catch {}
    }
    return null;
  }

  _isValidIpv4(ip) {
    const parts = ip.split('.');
    return parts.length === 4 && parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255 && part === num.toString();
    });
  }

  _isValidIpv6(ip) {
    return /:/.test(ip);
  }
}

class TerminalSessionHandler {
  constructor(logger) {
    this.logger = logger;
    this.process = null;
  }

  async cleanup() {
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
  }

  async startSession(requestId, server, token) {
    try {
      const terminalUrl = server.replace('http', 'ws') + `/api/clients/terminal?token=${token}&id=${requestId}`;
      const ws = new WebSocket(terminalUrl);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Terminal websocket connect timeout')), 10000);
      });
      await this._runTerminal(ws);
    } finally {
      await this.cleanup();
    }
  }

  async _runTerminal(websocket) {
    const shell = process.env.SHELL || '/bin/bash';
    const env = { ...process.env };
    delete env.PROMPT_COMMAND;

    this.process = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.env.PWD || process.cwd(),
      env
    });

    this.process.on('data', (data) => {
      if (websocket.readyState === WebSocket.OPEN) websocket.send(data);
    });

    this.process.on('exit', () => {
      if (websocket.readyState === WebSocket.OPEN) websocket.close();
    });

    websocket.on('message', (data) => {
      const message = data.toString();
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) return this.process.resize(parsed.cols, parsed.rows);
        if (parsed.type === 'input' && parsed.data) return this.process.write(Buffer.from(parsed.data, 'base64').toString());
        if (parsed.type === 'heartbeat') return;
      } catch {
        this.process.write(message);
      }
    });

    websocket.on('close', () => {
      try { this.process.kill(); } catch {}
    });

    await new Promise((resolve) => {
      this.process.on('exit', resolve);
      websocket.on('close', resolve);
    });
  }
}

class EventHandler {
  constructor(config, logger, disableRemoteControl = false) {
    this.config = config;
    this.logger = logger;
    this.disableRemoteControl = disableRemoteControl;
  }

  async handleEvent(event) {
    const messageType = event.message || '';
    switch (messageType) {
      case 'exec':
        await this._handleRemoteExec(event);
        break;
      case 'ping':
        await this._handlePingTask(event);
        break;
      case 'terminal':
        await this._handleTerminal(event);
        break;
      default:
        this.logger.warning(`Unknown event type: ${messageType}`);
    }
  }

  async _handleRemoteExec(event) {
    if (this.disableRemoteControl) return;
    const taskId = event.task_id || '';
    const command = event.command || '';
    if (!taskId || !command) return;
    if (this._isDangerousCommand(command)) {
      await this._reportExecResult(taskId, 'Command rejected by safety check', -3);
      return;
    }
    await this._executeCommand(taskId, command);
  }

  _isDangerousCommand(command) {
    const dangerousPatterns = ['rm -rf /', 'dd if=', ':(){ :|:& };:', 'reboot', 'poweroff'];
    const commandLower = command.toLowerCase();
    return dangerousPatterns.some(pattern => commandLower.includes(pattern));
  }

  async _executeCommand(taskId, command) {
    try {
      const isWindows = os.platform() === 'win32';
      const shellCmd = isWindows ? ['powershell', '-Command', command] : ['sh', '-c', command];
      const child = spawn(shellCmd[0], shellCmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000));
      const execution = new Promise((resolve) => child.on('close', resolve));

      let exitCode;
      try {
        exitCode = await Promise.race([execution, timeout]);
      } catch (e) {
        if (e.message === 'TIMEOUT') {
          child.kill();
          await this._reportExecResult(taskId, 'Command timed out (30 seconds)', -2);
          return;
        }
        throw e;
      }

      let output = stdout;
      if (stderr) output = output ? `${output}\n=== STDERR ===\n${stderr}` : stderr;
      if (output.length > 10000) output = `${output.substring(0, 10000)}\n... (truncated)`;
      if (!output) output = 'No output';
      await this._reportExecResult(taskId, output, exitCode || 0);
    } catch (e) {
      await this._reportExecResult(taskId, `Command execution error: ${e.message}`, -1);
    }
  }

  async _reportExecResult(taskId, result, exitCode) {
    const reportUrl = `${this.config.httpServer}/api/clients/task/result?token=${this.config.token}`;
    try {
      await fetchImpl(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, result, exit_code: exitCode, finished_at: new Date().toISOString() })
      });
    } catch (e) {
      this.logger.error(`Exec result report failed: ${e.message}`);
    }
  }

  async _handlePingTask(event) {
    const taskId = event.ping_task_id || '';
    const pingType = event.ping_type || '';
    const target = event.ping_target || '';
    if (!taskId || !pingType || !target) return;
    let value = -1;
    try {
      if (pingType === 'icmp') value = await this._pingIcmp(target);
      else if (pingType === 'tcp') value = await this._pingTcp(target);
      else if (pingType === 'http') value = await this._pingHttp(target);
    } catch {}
    if (this._wsSend) {
      this._wsSend({ type: 'ping_result', task_id: parseInt(taskId, 10), ping_type: pingType, value, finished_at: new Date().toISOString() });
    }
  }

  setWebsocketSender(fn) {
    this._wsSend = fn;
  }

  async _pingIcmp(target) {
    try {
      const isWindows = os.platform() === 'win32';
      const command = isWindows ? `ping -n 1 ${target}` : `ping -c 1 -W 1 ${target}`;
      const startTime = Date.now();
      const { stdout } = await execAsync(command, { timeout: 5000 });
      const elapsed = Date.now() - startTime;
      if (isWindows) {
        const match = stdout.match(/时间[=<](\d+)ms/);
        if (match) return parseFloat(match[1]);
      } else {
        const match = stdout.match(/time=([\d.]+)\s*ms/);
        if (match) return parseFloat(match[1]);
      }
      return elapsed;
    } catch {
      return -1;
    }
  }

  async _pingTcp(target) {
    try {
      const [host, portStr] = target.includes(':') ? target.split(':') : [target, '80'];
      const port = parseInt(portStr, 10);
      const startTime = Date.now();
      await new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(3000);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
        socket.once('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
        socket.connect(port, host);
      });
      return Date.now() - startTime;
    } catch {
      return -1;
    }
  }

  async _pingHttp(target) {
    try {
      const reqUrl = target.startsWith('http') ? target : `http://${target}`;
      const startTime = Date.now();
      await fetchImpl(reqUrl);
      return Date.now() - startTime;
    } catch {
      return -1;
    }
  }

  async _handleTerminal(event) {
    if (this.disableRemoteControl) return;
    const requestId = event.request_id || '';
    if (!requestId) return;
    const handler = new TerminalSessionHandler(this.logger);
    await handler.startSession(requestId, this.config.httpServer, this.config.token);
  }
}

class KomariMonitorClient {
  constructor(config, options = {}) {
    this.config = {
      httpServer: String(config.httpServer || '').replace(/\/+$/, ''),
      token: String(config.token || ''),
      interval: Number(config.interval || 5),
      reconnectInterval: Number(config.reconnectInterval || 10),
      logLevel: Number(config.logLevel || 0),
      disableRemoteControl: !!config.disableRemoteControl,
      ignoreUnsafeCert: config.ignoreUnsafeCert !== false
    };

    this.onLog = options.onLog || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.logger = new Logger(this.onLog, this.config.logLevel);
    this.systemInfo = new SystemInfoCollector(this.logger);
    this.eventHandler = new EventHandler(this.config, this.logger, this.config.disableRemoteControl);
    this.lastBasicInfoReport = 0;
    this.BASIC_INFO_INTERVAL = 300000;
    this.ws = null;
    this.sequence = 0;
    this.monitoringInterval = null;
    this.stopped = false;
    this.running = false;
  }

  async checkEnvironment() {
    const majorVersion = parseInt(process.version.slice(1).split('.')[0], 10);
    if (majorVersion < 14) throw new Error('Node.js 14 or higher required');
    for (const packageName of ['systeminformation', 'node-pty', 'ws']) require(packageName);
    return true;
  }

  async start() {
    if (this.running) return;
    if (!this.config.httpServer) throw new Error('HTTP server is required');
    if (!this.config.token) throw new Error('Token is required');

    this.stopped = false;
    this.running = true;
    this.onStatus({ state: 'starting', error: '' });
    await this.checkEnvironment();
    this.onStatus({ state: 'running', error: '' });

    while (!this.stopped) {
      try {
        await this._runMonitoringCycle();
        if (!this.stopped) await this._sleep(this.config.reconnectInterval * 1000);
      } catch (e) {
        this.logger.error(`Monitor cycle error: ${e.message}`);
        this.onStatus({ state: 'error', error: e.message || String(e) });
        if (!this.stopped) await this._sleep(this.config.reconnectInterval * 1000);
      }
    }

    this.running = false;
    this.onStatus({ state: 'stopped', error: '' });
  }

  async stop() {
    this.stopped = true;
    this._stopMonitoringLoop();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.running = false;
    this.onStatus({ state: 'stopped', error: '' });
  }

  async _runMonitoringCycle() {
    const basicInfoUrl = `${this.config.httpServer}/api/clients/uploadBasicInfo?token=${this.config.token}`;
    const wsUrl = this.config.httpServer.replace('http', 'ws') + `/api/clients/report?token=${this.config.token}`;
    await this._pushBasicInfo(basicInfoUrl);
    await this._startWebsocketMonitoring(wsUrl, basicInfoUrl);
  }

  async _pushBasicInfo(requestUrl) {
    const basicInfo = await this.systemInfo.getBasicInfo();
    const response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basicInfo)
    });
    if (response.status !== 200 && response.status !== 201) throw new Error(`Basic info push failed: HTTP ${response.status}`);
    this.lastBasicInfoReport = Date.now();
  }

  async _startWebsocketMonitoring(wsUrl, basicInfoUrl) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (this.config.ignoreUnsafeCert) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      this.ws = new WebSocket(wsUrl, { headers });

      this.eventHandler.setWebsocketSender((payload) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
      });

      this.ws.on('open', () => {
        this.onStatus({ state: 'running', error: '' });
        this._startMonitoringLoop(basicInfoUrl);
      });

      this.ws.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());
          await this.eventHandler.handleEvent(event);
        } catch (e) {
          this.logger.error(`WebSocket message handling error: ${e.message}`);
        }
      });

      this.ws.on('close', () => {
        this._stopMonitoringLoop();
        resolve();
      });

      this.ws.on('error', (e) => {
        this._stopMonitoringLoop();
        reject(e);
      });
    });
  }

  _startMonitoringLoop(basicInfoUrl) {
    const interval = Math.max(100, this.config.interval * 1000);
    this.monitoringInterval = setInterval(async () => {
      try {
        const currentTime = Date.now();
        if (currentTime - this.lastBasicInfoReport >= this.BASIC_INFO_INTERVAL) {
          await this._pushBasicInfo(basicInfoUrl);
        }
        const realtimeInfo = await this.systemInfo.getRealtimeInfo();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(realtimeInfo));
          this.sequence += 1;
        }
      } catch (e) {
        this.logger.error(`Realtime send failed: ${e.message}`);
        this._stopMonitoringLoop();
        try { this.ws.close(); } catch {}
      }
    }, interval);
  }

  _stopMonitoringLoop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { KomariMonitorClient, VERSION };
