const output = document.querySelector("[data-log-stream]");
if (output) {
  const stream = new EventSource(output.dataset.logStream);
  stream.onmessage = (event) => {
    output.textContent = `${output.textContent}${event.data}\n`.slice(-200000);
    output.scrollTop = output.scrollHeight;
  };
  stream.addEventListener("end", (event) => {
    document.querySelector("#log-status").textContent = event.data;
    stream.close();
  });
  stream.onerror = () => {
    document.querySelector("#log-status").textContent =
      "Log connection closed. Reload to reconnect.";
    stream.close();
  };
  window.addEventListener("pagehide", () => stream.close(), { once: true });
}
