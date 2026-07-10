const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EMERGENCE_MS = 210;
const RETRACTION_MS = 235;
const MIN_MOBILE_HEIGHT_PX = 44;
const MAX_CHARACTER_SCALE = 1.55;

export const HARP_TRICK_NAMES = Object.freeze([
  'backflip',
  'spin',
  'flex',
  'selfie'
]);

const BACK_RIG_MARKUP = `
  <g class="lead-success-harp-trick-backflip" data-trick="backflip" data-part="backflip-back-parts" opacity="0" visibility="hidden" hidden>
    <g data-part="left-arm" data-origin="26px 66px">
      <path class="lead-success-harp-limb" data-part="left-arm-line" data-limb d="M26 66 C10 68 -8 78 -24 94" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="left-hand" data-extremity cx="-24" cy="94" r="4.6" />
    </g>
    <g data-part="right-arm" data-origin="112px 65px">
      <path class="lead-success-harp-limb" data-part="right-arm-line" data-limb d="M112 65 C130 69 148 80 163 94" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="right-hand" data-extremity cx="163" cy="94" r="4.6" />
    </g>
    <g data-part="left-leg" data-origin="52px 120px">
      <path class="lead-success-harp-limb" data-part="left-leg-line" data-limb d="M52 120 C47 140 34 157 16 167" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="left-foot" data-extremity cx="13" cy="168" rx="6.5" ry="3.8" transform="rotate(-10 13 168)" />
    </g>
    <g data-part="right-leg" data-origin="78px 121px">
      <path class="lead-success-harp-limb" data-part="right-leg-line" data-limb d="M78 121 C87 141 103 157 119 164" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="right-foot" data-extremity cx="122" cy="165" rx="6.5" ry="3.8" transform="rotate(10 122 165)" />
    </g>
  </g>

  <g class="lead-success-harp-trick-spin" data-trick="spin" data-part="spin-back-parts" opacity="0" visibility="hidden" hidden>
    <g data-part="left-arm" data-origin="26px 65px">
      <path class="lead-success-harp-limb" data-part="left-arm-line" data-limb d="M26 65 C5 53 -20 52 -44 63" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="left-hand" data-extremity cx="-44" cy="63" r="4.6" />
    </g>
    <g data-part="right-arm" data-origin="112px 65px">
      <path class="lead-success-harp-limb" data-part="right-arm-line" data-limb d="M112 65 C137 52 160 54 184 65" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="right-hand" data-extremity cx="184" cy="65" r="4.6" />
    </g>
    <g data-part="left-leg" data-origin="52px 120px">
      <path class="lead-success-harp-limb" data-part="left-leg-line" data-limb d="M52 120 C48 141 39 155 27 165" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="left-foot" data-extremity cx="24" cy="166" rx="6.5" ry="3.8" transform="rotate(-7 24 166)" />
    </g>
    <g data-part="right-leg" data-origin="78px 121px">
      <path class="lead-success-harp-limb" data-part="right-leg-line" data-limb d="M78 121 C85 141 95 155 108 164" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="right-foot" data-extremity cx="111" cy="165" rx="6.5" ry="3.8" transform="rotate(7 111 165)" />
    </g>
  </g>

  <g class="lead-success-harp-trick-flex" data-trick="flex" data-part="flex-back-parts" opacity="0" visibility="hidden" hidden>
    <g data-part="left-arm" data-origin="27px 66px">
      <path class="lead-success-harp-limb" data-part="left-arm-line" data-limb d="M27 66 C8 72 -13 65 -20 48 C-27 31 -17 17 -3 17 C9 17 17 27 14 40" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="left-hand" data-extremity cx="14" cy="40" r="4.8" />
    </g>
    <g data-part="right-arm" data-origin="112px 66px">
      <path class="lead-success-harp-limb" data-part="right-arm-line" data-limb d="M112 66 C131 72 153 64 160 47 C167 30 157 16 143 17 C131 18 124 28 127 41" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="right-hand" data-extremity cx="127" cy="41" r="4.8" />
    </g>
    <g data-part="left-leg" data-origin="52px 120px">
      <path class="lead-success-harp-limb" data-part="left-leg-line" data-limb d="M52 120 C45 141 29 157 12 164" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="left-foot" data-extremity cx="9" cy="165" rx="6.8" ry="4" transform="rotate(-9 9 165)" />
    </g>
    <g data-part="right-leg" data-origin="78px 121px">
      <path class="lead-success-harp-limb" data-part="right-leg-line" data-limb d="M78 121 C89 141 106 156 123 162" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="right-foot" data-extremity cx="126" cy="163" rx="6.8" ry="4" transform="rotate(9 126 163)" />
    </g>
  </g>

  <g class="lead-success-harp-trick-selfie" data-trick="selfie" data-part="selfie-back-parts" opacity="0" visibility="hidden" hidden>
    <g data-part="left-arm" data-origin="26px 66px">
      <path class="lead-success-harp-limb" data-part="left-arm-line" data-limb d="M26 66 C6 62 -12 49 -24 35" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="left-hand" data-extremity cx="-24" cy="35" r="4.6" />
    </g>
    <g data-part="right-arm" data-origin="112px 65px">
      <path class="lead-success-harp-limb" data-part="right-arm-line" data-limb d="M112 65 C134 53 151 34 164 18" pathLength="1" />
      <circle class="lead-success-harp-hand" data-part="right-hand" data-extremity cx="164" cy="18" r="4.6" />
    </g>
    <g data-part="left-leg" data-origin="52px 120px">
      <path class="lead-success-harp-limb" data-part="left-leg-line" data-limb d="M52 120 C45 140 34 155 20 164" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="left-foot" data-extremity cx="17" cy="165" rx="6.5" ry="3.8" transform="rotate(-8 17 165)" />
    </g>
    <g data-part="right-leg" data-origin="78px 121px">
      <path class="lead-success-harp-limb" data-part="right-leg-line" data-limb d="M78 121 C90 138 106 149 122 151" pathLength="1" />
      <ellipse class="lead-success-harp-foot" data-part="right-foot" data-extremity cx="125" cy="151" rx="6.5" ry="3.8" transform="rotate(11 125 151)" />
    </g>
  </g>
`;

const FRONT_RIG_MARKUP = `
  <g class="lead-success-harp-trick-backflip" data-trick="backflip" data-part="backflip-front-parts" opacity="0" visibility="hidden" hidden></g>
  <g class="lead-success-harp-trick-spin" data-trick="spin" data-part="spin-front-parts" opacity="0" visibility="hidden" hidden></g>

  <g class="lead-success-harp-trick-flex" data-trick="flex" data-part="flex-front-parts" opacity="0" visibility="hidden" hidden>
    <path class="lead-success-harp-muscle-accent lead-success-harp-limb-accent" data-part="left-bicep-accent" data-origin="-5px 31px" d="M-21 48 C-18 27 -4 16 11 25" pathLength="1" opacity="0" />
    <path class="lead-success-harp-muscle-accent lead-success-harp-limb-accent" data-part="right-bicep-accent" data-origin="145px 31px" d="M161 47 C158 26 144 15 129 25" pathLength="1" opacity="0" />
  </g>

  <g class="lead-success-harp-trick-selfie" data-trick="selfie" data-part="selfie-front-parts" opacity="0" visibility="hidden" hidden>
    <g class="lead-success-harp-prop lead-success-harp-peace-sign" data-part="peace-sign" data-origin="-24px 35px" opacity="0">
      <path data-part="peace-finger-left" d="M-24 35 L-42 18" pathLength="1" fill="none" stroke="#f3f8ff" stroke-width="4" stroke-linecap="round" />
      <path data-part="peace-finger-right" d="M-24 35 L-27 12" pathLength="1" fill="none" stroke="#f3f8ff" stroke-width="4" stroke-linecap="round" />
    </g>
    <g class="lead-success-harp-phone" data-part="phone" data-origin="168px 11px" opacity="0">
      <rect data-part="phone-body" x="156" y="-8" width="24" height="38" rx="5" fill="#091425" stroke="#f3f8ff" stroke-width="3" />
      <circle data-part="phone-lens" cx="174" cy="-1" r="2.4" fill="#8fd0ff" />
      <path class="lead-success-harp-phone-screen" data-part="phone-screen-glint" d="M161 23 L169 23" pathLength="1" fill="none" stroke="#8fd0ff" stroke-width="2" stroke-linecap="round" />
    </g>
    <circle class="lead-success-harp-flash lead-success-harp-camera-flash" data-part="camera-flash" data-origin="174px -2px" cx="174" cy="-2" r="13" opacity="0" />
  </g>
`;

function clampRandomValue(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.min(0.999999999, Math.max(0, numericValue));
}

export function createHarpTrickSelector(randomSource = Math.random) {
  const getRandomValue = typeof randomSource === 'function' ? randomSource : Math.random;
  let bag = [];
  let lastTrick = null;

  function refillBag() {
    bag = [...HARP_TRICK_NAMES];
    for (let index = bag.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(clampRandomValue(getRandomValue()) * (index + 1));
      [bag[index], bag[randomIndex]] = [bag[randomIndex], bag[index]];
    }
  }

  function takeRandomTrick() {
    if (!bag.length) {
      refillBag();
    }

    if (bag[0] === lastTrick && bag.length > 1) {
      const replacementIndex = bag.findIndex((name) => name !== lastTrick);
      [bag[0], bag[replacementIndex]] = [bag[replacementIndex], bag[0]];
    }

    const selected = bag.shift();
    lastTrick = selected;
    return selected;
  }

  return function selectHarpTrick(requested = 'random') {
    if (HARP_TRICK_NAMES.includes(requested)) {
      const pendingIndex = bag.indexOf(requested);
      if (pendingIndex >= 0) {
        bag.splice(pendingIndex, 1);
      }
      lastTrick = requested;
      return requested;
    }
    return takeRandomTrick();
  };
}

function createRigLayer(documentObject, layer) {
  const svg = documentObject.createElementNS(SVG_NAMESPACE, 'svg');
  svg.classList.add('lead-success-harp-rig', `lead-success-harp-rig-${layer}`);
  svg.setAttribute('data-part', `rig-${layer}`);
  svg.setAttribute('viewBox', '0 0 140 136');
  svg.setAttribute('width', '140');
  svg.setAttribute('height', '136');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('overflow', 'visible');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = layer === 'back' ? BACK_RIG_MARKUP : FRONT_RIG_MARKUP;
  return svg;
}

function findDirectChild(parent, className) {
  return Array.from(parent?.children || []).find((child) => child.classList?.contains(className)) || null;
}

function mountRigLayers(motion, body) {
  const documentObject = motion?.ownerDocument;
  if (!documentObject || !body) {
    return { backRig: null, frontRig: null };
  }

  const backRig = findDirectChild(motion, 'lead-success-harp-rig-back')
    || createRigLayer(documentObject, 'back');
  const frontRig = findDirectChild(motion, 'lead-success-harp-rig-front')
    || createRigLayer(documentObject, 'front');

  if (backRig.nextSibling !== body) {
    motion.insertBefore(backRig, body);
  }
  if (frontRig.previousSibling !== body) {
    motion.insertBefore(frontRig, body.nextSibling);
  }

  return { backRig, frontRig };
}

function setTrickGroupVisibility(group, isVisible) {
  if (!group) {
    return;
  }
  group.toggleAttribute('hidden', !isVisible);
  group.setAttribute('visibility', isVisible ? 'visible' : 'hidden');
}

function getApparentCharacterScale(body) {
  const height = body?.getBoundingClientRect?.().height || body?.offsetHeight || 0;
  if (height <= 0) {
    return 1;
  }
  return Math.min(MAX_CHARACTER_SCALE, Math.max(1, MIN_MOBILE_HEIGHT_PX / height));
}

function playBackflip(context) {
  const { motion, animatePart } = context;
  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0) rotate(0deg)' },
      { offset: 0.12, transform: 'translate3d(0, 4px, 0) rotate(0deg) scaleY(0.96)', easing: 'cubic-bezier(0.5, 0, 0.8, 0.35)' },
      { offset: 0.34, transform: 'translate3d(-2px, -22px, 0) rotate(-118deg)', easing: 'linear' },
      { offset: 0.58, transform: 'translate3d(1px, -31px, 0) rotate(-238deg)', easing: 'linear' },
      { offset: 0.8, transform: 'translate3d(2px, -13px, 0) rotate(-344deg)', easing: 'cubic-bezier(0.2, 0.72, 0.3, 1)' },
      { offset: 0.93, transform: 'translate3d(0, 2px, 0) rotate(-360deg) scaleY(0.97)' },
      { offset: 1, transform: 'translate3d(0, 0, 0) rotate(-360deg)' }
    ], { duration: 1080, easing: 'linear' }),
    animatePart('left-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(-34deg)' },
      { offset: 0.36, transform: 'translate3d(13px, -5px, 0) rotate(66deg)' },
      { offset: 0.7, transform: 'translate3d(11px, -3px, 0) rotate(58deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 1080, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }),
    animatePart('right-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(34deg)' },
      { offset: 0.36, transform: 'translate3d(-13px, -5px, 0) rotate(-66deg)' },
      { offset: 0.7, transform: 'translate3d(-11px, -3px, 0) rotate(-58deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 1080, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }),
    animatePart('left-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.13, transform: 'rotate(-13deg) scaleY(0.9)' },
      { offset: 0.36, transform: 'translate3d(14px, -8px, 0) rotate(66deg) scaleY(0.82)' },
      { offset: 0.7, transform: 'translate3d(11px, -6px, 0) rotate(54deg) scaleY(0.86)' },
      { offset: 0.94, transform: 'rotate(-5deg) scaleY(0.94)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 1080, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }),
    animatePart('right-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.13, transform: 'rotate(13deg) scaleY(0.9)' },
      { offset: 0.36, transform: 'translate3d(-14px, -8px, 0) rotate(-66deg) scaleY(0.82)' },
      { offset: 0.7, transform: 'translate3d(-11px, -6px, 0) rotate(-54deg) scaleY(0.86)' },
      { offset: 0.94, transform: 'rotate(5deg) scaleY(0.94)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 1080, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' })
  ].filter(Boolean);
}

function playSpin(context) {
  const { motion, animatePart } = context;
  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0) rotate(0deg)' },
      { offset: 0.12, transform: 'translate3d(0, -3px, 0) rotate(0deg)' },
      { offset: 0.78, transform: 'translate3d(0, -4px, 0) rotate(360deg)', easing: 'cubic-bezier(0.18, 0.72, 0.26, 1)' },
      { offset: 0.91, transform: 'translate3d(0, -1px, 0) rotate(365deg)' },
      { offset: 1, transform: 'translate3d(0, 0, 0) rotate(360deg)' }
    ], { duration: 990, easing: 'cubic-bezier(0.38, 0, 0.2, 1)' }),
    animatePart('left-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.35, transform: 'rotate(-6deg)' },
      { offset: 0.76, transform: 'rotate(5deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 990, easing: 'ease-in-out' }),
    animatePart('right-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.35, transform: 'rotate(6deg)' },
      { offset: 0.76, transform: 'rotate(-5deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 990, easing: 'ease-in-out' }),
    animatePart('left-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.42, transform: 'rotate(8deg)' },
      { offset: 0.82, transform: 'rotate(-4deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 990, easing: 'ease-in-out' }),
    animatePart('right-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.42, transform: 'rotate(-8deg)' },
      { offset: 0.82, transform: 'rotate(4deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 990, easing: 'ease-in-out' })
  ].filter(Boolean);
}

function playFlex(context) {
  const { motion, animatePart } = context;
  const musclePulse = [
    { offset: 0, transform: 'scale(1)' },
    { offset: 0.2, transform: 'scale(1)' },
    { offset: 0.34, transform: 'scale(1.075)' },
    { offset: 0.45, transform: 'scale(1)' },
    { offset: 0.61, transform: 'scale(1.06)' },
    { offset: 0.72, transform: 'scale(1)' },
    { offset: 1, transform: 'scale(1)' }
  ];
  const accentPulse = [
    { offset: 0, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' },
    { offset: 0.2, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' },
    { offset: 0.34, opacity: 0.9, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 0.48, opacity: 0.48, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 0.61, opacity: 0.82, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 0.78, opacity: 0.4, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 1, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' }
  ];

  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0)' },
      { offset: 0.18, transform: 'translate3d(0, 2px, 0) scaleY(0.985)' },
      { offset: 0.34, transform: 'translate3d(0, -2px, 0)' },
      { offset: 0.72, transform: 'translate3d(0, -2px, 0)' },
      { offset: 1, transform: 'translate3d(0, 0, 0)' }
    ], { duration: 1060, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('left-arm', musclePulse, { duration: 1060, easing: 'ease-in-out' }),
    animatePart('right-arm', musclePulse, { duration: 1060, easing: 'ease-in-out' }),
    animatePart('left-bicep-accent', accentPulse, { duration: 1060, easing: 'ease-in-out' }),
    animatePart('right-bicep-accent', accentPulse, { duration: 1060, easing: 'ease-in-out' }),
    animatePart('left-leg', [
      { transform: 'rotate(0deg)' },
      { offset: 0.2, transform: 'rotate(-7deg)' },
      { offset: 0.78, transform: 'rotate(-7deg)' },
      { transform: 'rotate(0deg)' }
    ], { duration: 1060, easing: 'ease-in-out' }),
    animatePart('right-leg', [
      { transform: 'rotate(0deg)' },
      { offset: 0.2, transform: 'rotate(7deg)' },
      { offset: 0.78, transform: 'rotate(7deg)' },
      { transform: 'rotate(0deg)' }
    ], { duration: 1060, easing: 'ease-in-out' })
  ].filter(Boolean);
}

function playSelfie(context) {
  const { motion, animatePart } = context;
  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0) rotate(0deg)' },
      { offset: 0.22, transform: 'translate3d(3px, -2px, 0) rotate(3deg)' },
      { offset: 0.78, transform: 'translate3d(3px, -2px, 0) rotate(3deg)' },
      { offset: 1, transform: 'translate3d(0, 0, 0) rotate(0deg)' }
    ], { duration: 1100, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('right-arm', [
      { offset: 0, transform: 'rotate(8deg)' },
      { offset: 0.24, transform: 'rotate(-3deg)' },
      { offset: 0.78, transform: 'rotate(-3deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 1100, easing: 'ease-in-out' }),
    animatePart('left-arm', [
      { offset: 0, transform: 'rotate(-7deg)' },
      { offset: 0.28, transform: 'rotate(3deg)' },
      { offset: 0.78, transform: 'rotate(3deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration: 1100, easing: 'ease-in-out' }),
    animatePart('phone', [
      { offset: 0, opacity: 0, transform: 'translate3d(-6px, 8px, 0) rotate(-14deg) scale(0.84)' },
      { offset: 0.2, opacity: 1, transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)' },
      { offset: 0.8, opacity: 1, transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)' },
      { offset: 1, opacity: 0, transform: 'translate3d(-3px, 4px, 0) rotate(-7deg) scale(0.92)' }
    ], { duration: 1100, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('peace-sign', [
      { offset: 0, opacity: 0, transform: 'scale(0.7) rotate(-12deg)' },
      { offset: 0.26, opacity: 0, transform: 'scale(0.7) rotate(-12deg)' },
      { offset: 0.38, opacity: 1, transform: 'scale(1) rotate(0deg)' },
      { offset: 0.8, opacity: 1, transform: 'scale(1) rotate(0deg)' },
      { offset: 1, opacity: 0, transform: 'scale(0.82) rotate(-7deg)' }
    ], { duration: 1100, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('camera-flash', [
      { offset: 0, opacity: 0, transform: 'scale(0.42)' },
      { offset: 0.51, opacity: 0, transform: 'scale(0.42)' },
      { offset: 0.58, opacity: 0.72, transform: 'scale(0.72)' },
      { offset: 0.72, opacity: 0, transform: 'scale(1.65)' },
      { offset: 1, opacity: 0, transform: 'scale(1.65)' }
    ], { duration: 1100, easing: 'ease-out' })
  ].filter(Boolean);
}

export const HARP_TRICKS = Object.freeze({
  backflip: Object.freeze({ duration: 1080, play: playBackflip }),
  spin: Object.freeze({ duration: 990, play: playSpin }),
  flex: Object.freeze({ duration: 1060, play: playFlex }),
  selfie: Object.freeze({ duration: 1100, play: playSelfie })
});

export function createSuccessHarpCharacter(options = {}) {
  const {
    root,
    motionQuery,
    randomSource = Math.random
  } = options;
  const scale = root?.querySelector?.('.lead-success-harp-scale') || null;
  const motion = scale?.querySelector?.('.lead-success-harp-motion') || null;
  const body = motion?.querySelector?.('img.lead-success-harp-body') || null;
  const { backRig, frontRig } = mountRigLayers(motion, body);
  const rigLayers = [backRig, frontRig].filter(Boolean);
  const selectTrick = createHarpTrickSelector(randomSource);
  const activeAnimations = new Set();
  let runId = 0;

  function getTrickGroups(trickName) {
    return rigLayers.flatMap((rig) => Array.from(rig.querySelectorAll(`[data-trick="${trickName}"]`)));
  }

  function getAllTrickGroups() {
    return rigLayers.flatMap((rig) => Array.from(rig.querySelectorAll('[data-trick]')));
  }

  function cancelAnimations() {
    activeAnimations.forEach((animation) => {
      try {
        animation.cancel();
      } catch (_error) {
        // A finished animation can already have been detached by the browser.
      }
    });
    activeAnimations.clear();
  }

  function neutralize() {
    cancelAnimations();
    getAllTrickGroups().forEach((group) => setTrickGroupVisibility(group, false));
    rigLayers.forEach((rig) => {
      rig.querySelectorAll('[data-origin]').forEach((part) => {
        part.style.removeProperty('transform-box');
        part.style.removeProperty('transform-origin');
      });
    });

    [scale, motion].forEach((element) => {
      element?.style?.removeProperty('transform');
      element?.style?.removeProperty('transform-origin');
      element?.style?.removeProperty('will-change');
    });

    root?.classList?.remove('is-harp-character-active');
    if (root?.dataset) {
      delete root.dataset.harpTrick;
    } else {
      root?.removeAttribute?.('data-harp-trick');
    }
  }

  function reset() {
    runId += 1;
    neutralize();
  }

  function startAnimation(element, keyframes, animationOptions = {}) {
    if (!element || typeof element.animate !== 'function') {
      return null;
    }

    const animation = element.animate(keyframes, {
      fill: 'both',
      ...animationOptions
    });
    if (!animation) {
      return null;
    }

    activeAnimations.add(animation);
    return {
      animation,
      finished: animation.finished
        ? Promise.resolve(animation.finished).then(() => true, () => false)
        : Promise.resolve(true)
    };
  }

  async function waitForAnimations(records) {
    const activeRecords = records.flat(Infinity).filter(Boolean);
    const results = await Promise.all(activeRecords.map((record) => record.finished));
    return results.every(Boolean);
  }

  function prepareTrick(trickName) {
    const groups = getTrickGroups(trickName);
    groups.forEach((group) => {
      setTrickGroupVisibility(group, true);
      group.querySelectorAll('[data-origin]').forEach((part) => {
        part.style.setProperty('transform-box', 'view-box');
        part.style.setProperty('transform-origin', part.getAttribute('data-origin'));
      });
    });

    root.classList.add('is-harp-character-active');
    root.dataset.harpTrick = trickName;
    scale.style.setProperty('transform-origin', '50% 100%');
    scale.style.setProperty('will-change', 'transform');
    motion.style.setProperty('transform-origin', '50% 66%');
    motion.style.setProperty('will-change', 'transform');
    return groups;
  }

  function findPart(groups, partName) {
    for (const group of groups) {
      if (group.getAttribute('data-part') === partName) {
        return group;
      }
      const part = group.querySelector(`[data-part="${partName}"]`);
      if (part) {
        return part;
      }
    }
    return null;
  }

  function animateEmergence(groups, characterScale) {
    const records = groups.map((group) => startAnimation(group, [
      { opacity: 0 },
      { opacity: 1 }
    ], { duration: 155, easing: 'ease-out' }));

    const limbPaths = groups.flatMap((group) => Array.from(group.querySelectorAll('[data-limb]')));
    limbPaths.forEach((limb, index) => {
      records.push(startAnimation(limb, [
        { opacity: 0.25, strokeDasharray: '1', strokeDashoffset: '1' },
        { opacity: 1, strokeDasharray: '1', strokeDashoffset: '0' }
      ], {
        delay: index * 4,
        duration: EMERGENCE_MS - (index * 4),
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      }));
    });

    groups.flatMap((group) => Array.from(group.querySelectorAll('[data-extremity]'))).forEach((extremity, index) => {
      records.push(startAnimation(extremity, [
        { opacity: 0 },
        { offset: 0.46, opacity: 0 },
        { opacity: 1 }
      ], {
        delay: index * 4,
        duration: EMERGENCE_MS - (index * 4),
        easing: 'ease-out'
      }));
    });

    records.push(startAnimation(scale, [
      { transform: 'scale(1)' },
      { transform: `scale(${characterScale})` }
    ], { duration: EMERGENCE_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }));
    return records;
  }

  function animateRetraction(groups, characterScale) {
    const records = groups.map((group) => startAnimation(group, [
      { opacity: 1 },
      { opacity: 0 }
    ], { duration: RETRACTION_MS, easing: 'ease-in' }));

    groups.flatMap((group) => Array.from(group.querySelectorAll('[data-limb]'))).forEach((limb, index) => {
      records.push(startAnimation(limb, [
        { opacity: 1, strokeDasharray: '1', strokeDashoffset: '0' },
        { opacity: 0.2, strokeDasharray: '1', strokeDashoffset: '1' }
      ], {
        delay: index * 3,
        duration: RETRACTION_MS - (index * 3),
        easing: 'cubic-bezier(0.4, 0, 1, 1)'
      }));
    });

    groups.flatMap((group) => Array.from(group.querySelectorAll('[data-extremity]'))).forEach((extremity, index) => {
      records.push(startAnimation(extremity, [
        { opacity: 1 },
        { offset: 0.48, opacity: 1 },
        { opacity: 0 }
      ], {
        delay: index * 3,
        duration: RETRACTION_MS - (index * 3),
        easing: 'ease-in'
      }));
    });

    records.push(startAnimation(scale, [
      { transform: `scale(${characterScale})` },
      { transform: 'scale(1)' }
    ], { duration: RETRACTION_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }));
    return records;
  }

  async function play(playOptions = {}) {
    reset();
    const currentRunId = runId;

    if (!root || !scale || !motion || !body || !rigLayers.length) {
      return null;
    }
    if (motionQuery?.matches || typeof motion.animate !== 'function' || typeof scale.animate !== 'function') {
      return null;
    }

    const selectedTrick = selectTrick(playOptions.trickName ?? 'random');
    const groups = prepareTrick(selectedTrick);
    const characterScale = getApparentCharacterScale(body);
    const animatePart = (partName, keyframes, animationOptions) => startAnimation(
      findPart(groups, partName),
      keyframes,
      animationOptions
    );
    const context = {
      motion,
      animate: startAnimation,
      animatePart
    };

    try {
      const emerged = await waitForAnimations(animateEmergence(groups, characterScale));
      if (!emerged || currentRunId !== runId) {
        return null;
      }

      const performed = await waitForAnimations(HARP_TRICKS[selectedTrick].play(context));
      if (!performed || currentRunId !== runId) {
        return null;
      }

      const retracted = await waitForAnimations(animateRetraction(groups, characterScale));
      if (!retracted || currentRunId !== runId) {
        return null;
      }

      neutralize();
      return selectedTrick;
    } catch (_error) {
      if (currentRunId === runId) {
        neutralize();
      }
      return null;
    }
  }

  neutralize();

  return {
    play,
    reset
  };
}
