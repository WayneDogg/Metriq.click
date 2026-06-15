(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.getElementById("signalCanvas");
  const context = canvas ? canvas.getContext("2d") : null;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let points = [];
  let animationFrame = null;

  function setCanvasSize() {
    if (!canvas || !context) return;
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.offsetWidth;
    height = canvas.offsetHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    points = createPoints(width, height);
    drawScene(0);
  }

  function createPoints(sceneWidth, sceneHeight) {
    const count = Math.max(34, Math.floor((sceneWidth * sceneHeight) / 34000));
    return Array.from({ length: count }, function (_, index) {
      return {
        x: Math.random() * sceneWidth,
        y: Math.random() * sceneHeight,
        baseX: Math.random() * sceneWidth,
        baseY: Math.random() * sceneHeight,
        radius: 1.2 + Math.random() * 2.2,
        speed: 0.00055 + Math.random() * 0.0011,
        phase: Math.random() * Math.PI * 2,
        tone: index % 9 === 0 ? "amber" : index % 4 === 0 ? "green" : "cyan"
      };
    });
  }

  function drawScene(time) {
    if (!context) return;
    context.clearRect(0, 0, width, height);

    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "rgba(6, 8, 12, 0.96)");
    gradient.addColorStop(0.45, "rgba(13, 18, 22, 0.8)");
    gradient.addColorStop(1, "rgba(8, 9, 12, 0.98)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    drawGrid(time);
    updatePoints(time);
    drawLinks();
    drawPoints(time);
    drawTickerLines(time);

    if (!reduceMotion) {
      animationFrame = window.requestAnimationFrame(drawScene);
    }
  }

  function drawGrid(time) {
    const spacing = width < 760 ? 56 : 82;
    const offset = reduceMotion ? 0 : (time * 0.012) % spacing;
    context.lineWidth = 1;
    context.strokeStyle = "rgba(255, 255, 255, 0.035)";

    for (let x = -spacing + offset; x < width + spacing; x += spacing) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + width * 0.12, height);
      context.stroke();
    }

    for (let y = -spacing + offset; y < height + spacing; y += spacing) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y - height * 0.08);
      context.stroke();
    }
  }

  function updatePoints(time) {
    points.forEach(function (point, index) {
      if (reduceMotion) {
        point.x = point.baseX;
        point.y = point.baseY;
        return;
      }

      const drift = time * point.speed + point.phase;
      point.x = point.baseX + Math.cos(drift) * (18 + (index % 5) * 5);
      point.y = point.baseY + Math.sin(drift * 1.15) * (14 + (index % 7) * 4);
    });
  }

  function drawLinks() {
    const maxDistance = width < 760 ? 126 : 156;

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const first = points[i];
        const second = points[j];
        const dx = first.x - second.x;
        const dy = first.y - second.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < maxDistance) {
          const alpha = (1 - distance / maxDistance) * 0.2;
          context.strokeStyle = "rgba(72, 240, 239, " + alpha.toFixed(3) + ")";
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(first.x, first.y);
          context.lineTo(second.x, second.y);
          context.stroke();
        }
      }
    }
  }

  function colorFor(point, alpha) {
    if (point.tone === "green") return "rgba(141, 245, 170, " + alpha + ")";
    if (point.tone === "amber") return "rgba(255, 199, 102, " + alpha + ")";
    return "rgba(72, 240, 239, " + alpha + ")";
  }

  function drawPoints(time) {
    points.forEach(function (point) {
      const pulse = reduceMotion ? 0.7 : 0.55 + Math.sin(time * 0.0025 + point.phase) * 0.22;
      context.beginPath();
      context.arc(point.x, point.y, point.radius + pulse, 0, Math.PI * 2);
      context.fillStyle = colorFor(point, 0.72);
      context.fill();

      context.beginPath();
      context.arc(point.x, point.y, point.radius * 5 + pulse * 6, 0, Math.PI * 2);
      context.fillStyle = colorFor(point, 0.055);
      context.fill();
    });
  }

  function drawTickerLines(time) {
    const lanes = [0.2, 0.36, 0.52, 0.68, 0.84];
    lanes.forEach(function (lane, index) {
      const y = height * lane;
      const speed = reduceMotion ? 0 : time * (0.04 + index * 0.008);
      const x = (speed + index * 180) % (width + 260) - 260;
      const line = context.createLinearGradient(x, y, x + 220, y);
      line.addColorStop(0, "rgba(72, 240, 239, 0)");
      line.addColorStop(0.5, index % 2 ? "rgba(141, 245, 170, 0.36)" : "rgba(72, 240, 239, 0.42)");
      line.addColorStop(1, "rgba(72, 240, 239, 0)");
      context.strokeStyle = line;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + 220, y - 24);
      context.stroke();
    });
  }

  function initReveal() {
    const revealItems = Array.from(document.querySelectorAll("[data-reveal]"));

    if (reduceMotion || !("IntersectionObserver" in window)) {
      revealItems.forEach(function (item) {
        item.classList.add("is-visible");
      });
      return;
    }

    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
    );

    revealItems.forEach(function (item) {
      observer.observe(item);
    });
  }

  function initForm() {
    const form = document.getElementById("applicationForm");
    const message = document.getElementById("formMessage");
    if (!form || !message) return;

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      const fields = Array.from(form.querySelectorAll("input, select, textarea"));
      fields.forEach(function (field) {
        field.removeAttribute("aria-invalid");
      });

      const invalidFields = fields.filter(function (field) {
        return !field.checkValidity();
      });

      if (invalidFields.length) {
        invalidFields.forEach(function (field) {
          field.setAttribute("aria-invalid", "true");
        });
        invalidFields[0].focus();
        message.textContent = "Please complete the highlighted fields so the application has enough context.";
        message.className = "form-message error";
        return;
      }

      const name = new FormData(form).get("name");
      form.reset();
      message.textContent = "Application captured for review. The next step is to connect this form to Metriq's chosen CRM or booking workflow.";
      if (name) {
        message.textContent = "Thanks, " + name + ". " + message.textContent;
      }
      message.className = "form-message success";
    });
  }

  window.addEventListener("resize", function () {
    window.clearTimeout(window.__metriqResizeTimer);
    window.__metriqResizeTimer = window.setTimeout(setCanvasSize, 140);
  });

  setCanvasSize();
  if (!reduceMotion && canvas) {
    animationFrame = window.requestAnimationFrame(drawScene);
  }
  initReveal();
  initForm();

  window.addEventListener("beforeunload", function () {
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
    }
  });
})();
