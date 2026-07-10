const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EMERGENCE_MS = 245;
const RETRACTION_MS = 245;
const MIN_MOBILE_HEIGHT_PX = 44;
const MAX_CHARACTER_SCALE = 1.55;

export const HARP_TRICK_NAMES = Object.freeze([
  'backflip',
  'spin',
  'flex',
  'selfie'
]);

const ARTICULATED_LIMB_PARTS = Object.freeze([
  'left-arm',
  'left-elbow',
  'left-forearm',
  'left-hand',
  'right-arm',
  'right-elbow',
  'right-forearm',
  'right-hand',
  'left-leg',
  'left-knee',
  'left-shin',
  'left-foot',
  'right-leg',
  'right-knee',
  'right-shin',
  'right-foot'
]);

export const HARP_TRICK_REQUIRED_PARTS = Object.freeze({
  backflip: ARTICULATED_LIMB_PARTS,
  spin: ARTICULATED_LIMB_PARTS,
  flex: Object.freeze([
    ...ARTICULATED_LIMB_PARTS,
    'left-bicep',
    'right-bicep',
    'left-bicep-crease',
    'right-bicep-crease'
  ]),
  selfie: Object.freeze([
    ...ARTICULATED_LIMB_PARTS,
    'phone',
    'peace-sign',
    'camera-flash'
  ])
});

function point([x, y]) {
  return `${x} ${y}`;
}

function origin([x, y]) {
  return `${x}px ${y}px`;
}

function createArmMarkup(options) {
  const {
    side,
    shoulder,
    elbow,
    wrist,
    handAngle = 0,
    bicep = null
  } = options;
  const [shoulderX, shoulderY] = shoulder;
  const [elbowX, elbowY] = elbow;
  const [wristX, wristY] = wrist;
  const upperControl = [
    shoulderX + ((elbowX - shoulderX) * 0.48),
    shoulderY + ((elbowY - shoulderY) * 0.42)
  ];
  const lowerControl = [
    elbowX + ((wristX - elbowX) * 0.52),
    elbowY + ((wristY - elbowY) * 0.46)
  ];
  const bicepMarkup = bicep
    ? `<g data-part="${side}-bicep" data-origin="${origin(bicep.center)}" data-extremity data-growth-order="1">
        <ellipse class="lead-success-harp-bicep" cx="${bicep.center[0]}" cy="${bicep.center[1]}" rx="${bicep.rx}" ry="${bicep.ry}" transform="rotate(${bicep.angle} ${point(bicep.center)})" />
      </g>`
    : '';

  return `
    <g data-part="${side}-arm" data-origin="${origin(shoulder)}">
      <path class="lead-success-harp-limb lead-success-harp-upper-limb" data-part="${side}-upper-arm-line" data-limb data-growth-order="0" d="M${point(shoulder)} Q${point(upperControl)} ${point(elbow)}" pathLength="1" />
      ${bicepMarkup}
      <circle class="lead-success-harp-joint" data-part="${side}-elbow" data-extremity data-growth-order="1" cx="${elbowX}" cy="${elbowY}" r="4.7" />
      <g data-part="${side}-forearm" data-origin="${origin(elbow)}">
        <path class="lead-success-harp-limb lead-success-harp-lower-limb" data-part="${side}-forearm-line" data-limb data-growth-order="1" d="M${point(elbow)} Q${point(lowerControl)} ${point(wrist)}" pathLength="1" />
        <ellipse class="lead-success-harp-hand" data-part="${side}-hand" data-extremity data-growth-order="2" cx="${wristX}" cy="${wristY}" rx="6.1" ry="4.8" transform="rotate(${handAngle} ${wristX} ${wristY})" />
      </g>
    </g>`;
}

function createLegMarkup(options) {
  const {
    side,
    hip,
    knee,
    ankle,
    footAngle = 0
  } = options;
  const [hipX, hipY] = hip;
  const [kneeX, kneeY] = knee;
  const [ankleX, ankleY] = ankle;
  const thighControl = [
    hipX + ((kneeX - hipX) * 0.5),
    hipY + ((kneeY - hipY) * 0.46)
  ];
  const shinControl = [
    kneeX + ((ankleX - kneeX) * 0.52),
    kneeY + ((ankleY - kneeY) * 0.48)
  ];

  return `
    <g data-part="${side}-leg" data-origin="${origin(hip)}">
      <path class="lead-success-harp-limb lead-success-harp-upper-limb" data-part="${side}-thigh-line" data-limb data-growth-order="0" d="M${point(hip)} Q${point(thighControl)} ${point(knee)}" pathLength="1" />
      <circle class="lead-success-harp-joint" data-part="${side}-knee" data-extremity data-growth-order="1" cx="${kneeX}" cy="${kneeY}" r="4.9" />
      <g data-part="${side}-shin" data-origin="${origin(knee)}">
        <path class="lead-success-harp-limb lead-success-harp-lower-limb" data-part="${side}-shin-line" data-limb data-growth-order="1" d="M${point(knee)} Q${point(shinControl)} ${point(ankle)}" pathLength="1" />
        <ellipse class="lead-success-harp-foot" data-part="${side}-foot" data-extremity data-growth-order="2" cx="${ankleX}" cy="${ankleY}" rx="7.2" ry="4.2" transform="rotate(${footAngle} ${ankleX} ${ankleY})" />
      </g>
    </g>`;
}

const BACK_RIG_MARKUP = `
  <g class="lead-success-harp-trick-backflip" data-trick="backflip" data-part="backflip-back-parts" opacity="0" visibility="hidden" hidden>
    ${createArmMarkup({ side: 'left', shoulder: [26, 68], elbow: [-2, 82], wrist: [-22, 102], handAngle: -32 })}
    ${createArmMarkup({ side: 'right', shoulder: [112, 67], elbow: [140, 82], wrist: [160, 102], handAngle: 32 })}
    ${createLegMarkup({ side: 'left', hip: [52, 120], knee: [45, 143], ankle: [26, 163], footAngle: -10 })}
    ${createLegMarkup({ side: 'right', hip: [78, 121], knee: [88, 143], ankle: [108, 162], footAngle: 10 })}
  </g>

  <g class="lead-success-harp-trick-spin" data-trick="spin" data-part="spin-back-parts" opacity="0" visibility="hidden" hidden>
    ${createArmMarkup({ side: 'left', shoulder: [26, 66], elbow: [-8, 60], wrist: [-42, 64], handAngle: -6 })}
    ${createArmMarkup({ side: 'right', shoulder: [112, 65], elbow: [148, 60], wrist: [182, 65], handAngle: 6 })}
    ${createLegMarkup({ side: 'left', hip: [52, 120], knee: [45, 143], ankle: [27, 164], footAngle: -7 })}
    ${createLegMarkup({ side: 'right', hip: [78, 121], knee: [88, 143], ankle: [108, 163], footAngle: 7 })}
  </g>

  <g class="lead-success-harp-trick-flex" data-trick="flex" data-part="flex-back-parts" opacity="0" visibility="hidden" hidden>
    ${createArmMarkup({ side: 'left', shoulder: [25, 70], elbow: [-14, 53], wrist: [0, 26], handAngle: 28, bicep: { center: [4, 61], rx: 12.5, ry: 7.4, angle: 22 } })}
    ${createArmMarkup({ side: 'right', shoulder: [114, 70], elbow: [154, 53], wrist: [140, 26], handAngle: -28, bicep: { center: [136, 61], rx: 12.5, ry: 7.4, angle: -22 } })}
    ${createLegMarkup({ side: 'left', hip: [52, 120], knee: [38, 143], ankle: [14, 163], footAngle: -9 })}
    ${createLegMarkup({ side: 'right', hip: [78, 121], knee: [99, 143], ankle: [126, 161], footAngle: 9 })}
  </g>

  <g class="lead-success-harp-trick-selfie" data-trick="selfie" data-part="selfie-back-parts" opacity="0" visibility="hidden" hidden>
    ${createArmMarkup({ side: 'left', shoulder: [26, 66], elbow: [0, 55], wrist: [-24, 36], handAngle: -32 })}
    ${createArmMarkup({ side: 'right', shoulder: [112, 65], elbow: [142, 48], wrist: [164, 18], handAngle: 32 })}
    ${createLegMarkup({ side: 'left', hip: [52, 120], knee: [43, 143], ankle: [20, 163], footAngle: -8 })}
    ${createLegMarkup({ side: 'right', hip: [78, 121], knee: [99, 139], ankle: [123, 151], footAngle: 11 })}
  </g>
`;

const FRONT_RIG_MARKUP = `
  <g class="lead-success-harp-trick-backflip" data-trick="backflip" data-part="backflip-front-parts" opacity="0" visibility="hidden" hidden></g>
  <g class="lead-success-harp-trick-spin" data-trick="spin" data-part="spin-front-parts" opacity="0" visibility="hidden" hidden></g>

  <g class="lead-success-harp-trick-flex" data-trick="flex" data-part="flex-front-parts" opacity="0" visibility="hidden" hidden>
    <path class="lead-success-harp-muscle-crease lead-success-harp-limb-accent" data-part="left-bicep-crease" data-origin="4px 61px" d="M-5 59 Q4 51 13 59" pathLength="1" opacity="0" />
    <path class="lead-success-harp-muscle-crease lead-success-harp-limb-accent" data-part="right-bicep-crease" data-origin="136px 61px" d="M127 59 Q136 51 145 59" pathLength="1" opacity="0" />
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
  const duration = 1160;
  const animateJoint = (partName, values) => animatePart(partName, values, {
    duration,
    easing: 'linear'
  });

  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0) rotate(0deg)' },
      { offset: 0.16, transform: 'translate3d(0, 6%, 0) rotate(0deg)', easing: 'cubic-bezier(0.55, 0, 0.75, 0.35)' },
      { offset: 0.24, transform: 'translate3d(-1%, -4%, 0) rotate(-8deg)', easing: 'cubic-bezier(0.16, 0.72, 0.22, 1)' },
      { offset: 0.36, transform: 'translate3d(-2%, -29%, 0) rotate(-92deg)' },
      { offset: 0.49, transform: 'translate3d(0, -44%, 0) rotate(-182deg)' },
      { offset: 0.58, transform: 'translate3d(1%, -47%, 0) rotate(-230deg)' },
      { offset: 0.7, transform: 'translate3d(2%, -36%, 0) rotate(-310deg)' },
      { offset: 0.8, transform: 'translate3d(1%, -18%, 0) rotate(-348deg)', easing: 'cubic-bezier(0.18, 0.72, 0.24, 1)' },
      { offset: 0.87, transform: 'translate3d(0, 0, 0) rotate(-360deg)' },
      { offset: 0.91, transform: 'translate3d(0, 5%, 0) rotate(-360deg)', easing: 'cubic-bezier(0.2, 0, 0.35, 1)' },
      { offset: 0.96, transform: 'translate3d(0, -1%, 0) rotate(-360deg)' },
      { offset: 1, transform: 'translate3d(0, 0, 0) rotate(-360deg)' }
    ], { duration, easing: 'linear' }),
    animateJoint('left-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(28deg)' },
      { offset: 0.25, transform: 'rotate(-48deg)' },
      { offset: 0.42, transform: 'rotate(66deg)' },
      { offset: 0.66, transform: 'rotate(58deg)' },
      { offset: 0.8, transform: 'rotate(-18deg)' },
      { offset: 0.91, transform: 'rotate(16deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animateJoint('right-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(-28deg)' },
      { offset: 0.25, transform: 'rotate(48deg)' },
      { offset: 0.42, transform: 'rotate(-66deg)' },
      { offset: 0.66, transform: 'rotate(-58deg)' },
      { offset: 0.8, transform: 'rotate(18deg)' },
      { offset: 0.91, transform: 'rotate(-16deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animateJoint('left-forearm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(-18deg)' },
      { offset: 0.25, transform: 'rotate(8deg)' },
      { offset: 0.42, transform: 'rotate(102deg)' },
      { offset: 0.66, transform: 'rotate(92deg)' },
      { offset: 0.8, transform: 'rotate(12deg)' },
      { offset: 0.91, transform: 'rotate(-18deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animateJoint('right-forearm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(18deg)' },
      { offset: 0.25, transform: 'rotate(-8deg)' },
      { offset: 0.42, transform: 'rotate(-102deg)' },
      { offset: 0.66, transform: 'rotate(-92deg)' },
      { offset: 0.8, transform: 'rotate(-12deg)' },
      { offset: 0.91, transform: 'rotate(18deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animateJoint('left-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(-22deg)' },
      { offset: 0.25, transform: 'rotate(-4deg)' },
      { offset: 0.42, transform: 'rotate(88deg)' },
      { offset: 0.62, transform: 'rotate(88deg)' },
      { offset: 0.8, transform: 'rotate(-6deg)' },
      { offset: 0.87, transform: 'rotate(-10deg)' },
      { offset: 0.91, transform: 'rotate(-18deg)' },
      { offset: 0.96, transform: 'rotate(-4deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animateJoint('right-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(22deg)' },
      { offset: 0.25, transform: 'rotate(4deg)' },
      { offset: 0.42, transform: 'rotate(-88deg)' },
      { offset: 0.62, transform: 'rotate(-88deg)' },
      { offset: 0.8, transform: 'rotate(6deg)' },
      { offset: 0.87, transform: 'rotate(10deg)' },
      { offset: 0.91, transform: 'rotate(18deg)' },
      { offset: 0.96, transform: 'rotate(4deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animateJoint('left-shin', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(46deg)' },
      { offset: 0.25, transform: 'rotate(8deg)' },
      { offset: 0.42, transform: 'rotate(-120deg)' },
      { offset: 0.62, transform: 'rotate(-120deg)' },
      { offset: 0.8, transform: 'rotate(8deg)' },
      { offset: 0.87, transform: 'rotate(18deg)' },
      { offset: 0.91, transform: 'rotate(38deg)' },
      { offset: 0.96, transform: 'rotate(8deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animateJoint('right-shin', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.16, transform: 'rotate(-46deg)' },
      { offset: 0.25, transform: 'rotate(-8deg)' },
      { offset: 0.42, transform: 'rotate(120deg)' },
      { offset: 0.62, transform: 'rotate(120deg)' },
      { offset: 0.8, transform: 'rotate(-8deg)' },
      { offset: 0.87, transform: 'rotate(-18deg)' },
      { offset: 0.91, transform: 'rotate(-38deg)' },
      { offset: 0.96, transform: 'rotate(-8deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ])
  ].filter(Boolean);
}

function playSpin(context) {
  const { motion, animatePart } = context;
  const duration = 1020;
  const animatePose = (partName, keyframes) => animatePart(partName, keyframes, {
    duration,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
  });

  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0) rotate(0deg)' },
      { offset: 0.12, transform: 'translate3d(0, 2%, 0) rotate(-4deg)' },
      { offset: 0.22, transform: 'translate3d(0, -5%, 0) rotate(8deg)' },
      { offset: 0.78, transform: 'translate3d(0, -6%, 0) rotate(360deg)', easing: 'cubic-bezier(0.18, 0.72, 0.26, 1)' },
      { offset: 0.91, transform: 'translate3d(0, -1%, 0) rotate(365deg)' },
      { offset: 1, transform: 'translate3d(0, 0, 0) rotate(360deg)' }
    ], { duration, easing: 'cubic-bezier(0.38, 0, 0.2, 1)' }),
    animatePose('left-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.22, transform: 'rotate(4deg)' },
      { offset: 0.38, transform: 'rotate(16deg)' },
      { offset: 0.7, transform: 'rotate(16deg)' },
      { offset: 0.86, transform: 'rotate(-3deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animatePose('right-arm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.22, transform: 'rotate(-4deg)' },
      { offset: 0.38, transform: 'rotate(-16deg)' },
      { offset: 0.7, transform: 'rotate(-16deg)' },
      { offset: 0.86, transform: 'rotate(3deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animatePose('left-forearm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.34, transform: 'rotate(38deg)' },
      { offset: 0.7, transform: 'rotate(38deg)' },
      { offset: 0.86, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animatePose('right-forearm', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.34, transform: 'rotate(-38deg)' },
      { offset: 0.7, transform: 'rotate(-38deg)' },
      { offset: 0.86, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animatePose('left-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.25, transform: 'rotate(6deg)' },
      { offset: 0.68, transform: 'rotate(10deg)' },
      { offset: 0.84, transform: 'rotate(-5deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animatePose('right-leg', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.25, transform: 'rotate(-6deg)' },
      { offset: 0.68, transform: 'rotate(-10deg)' },
      { offset: 0.84, transform: 'rotate(5deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animatePose('left-shin', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.25, transform: 'rotate(-12deg)' },
      { offset: 0.68, transform: 'rotate(-18deg)' },
      { offset: 0.86, transform: 'rotate(4deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ]),
    animatePose('right-shin', [
      { offset: 0, transform: 'rotate(0deg)' },
      { offset: 0.25, transform: 'rotate(12deg)' },
      { offset: 0.68, transform: 'rotate(18deg)' },
      { offset: 0.86, transform: 'rotate(-4deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ])
  ].filter(Boolean);
}

function playFlex(context) {
  const { motion, animatePart } = context;
  const duration = 1120;
  const musclePulse = [
    { offset: 0, opacity: 0.88, transform: 'scale(0.92)' },
    { offset: 0.28, opacity: 1, transform: 'scale(1)' },
    { offset: 0.41, opacity: 1, transform: 'scale(1.12)' },
    { offset: 0.51, opacity: 1, transform: 'scale(1.03)' },
    { offset: 0.64, opacity: 1, transform: 'scale(1.1)' },
    { offset: 0.74, opacity: 1, transform: 'scale(1.03)' },
    { offset: 0.88, opacity: 1, transform: 'scale(1.05)' },
    { offset: 1, transform: 'scale(1)' }
  ];
  const creasePulse = [
    { offset: 0, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' },
    { offset: 0.3, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' },
    { offset: 0.41, opacity: 0.94, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 0.52, opacity: 0.42, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 0.64, opacity: 0.86, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 0.76, opacity: 0.44, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 0.88, opacity: 0.52, strokeDasharray: '1', strokeDashoffset: '0' },
    { offset: 1, opacity: 0, strokeDasharray: '1', strokeDashoffset: '1' }
  ];

  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0)' },
      { offset: 0.16, transform: 'translate3d(0, 2%, 0)' },
      { offset: 0.3, transform: 'translate3d(0, -2%, 0)' },
      { offset: 0.88, transform: 'translate3d(0, -2%, 0)' },
      { offset: 1, transform: 'translate3d(0, 0, 0)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('left-arm', [
      { offset: 0, transform: 'rotate(12deg)' },
      { offset: 0.28, transform: 'rotate(0deg)' },
      { offset: 0.88, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('right-arm', [
      { offset: 0, transform: 'rotate(-12deg)' },
      { offset: 0.28, transform: 'rotate(0deg)' },
      { offset: 0.88, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('left-forearm', [
      { offset: 0, transform: 'rotate(-22deg)' },
      { offset: 0.3, transform: 'rotate(0deg)' },
      { offset: 0.88, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('right-forearm', [
      { offset: 0, transform: 'rotate(22deg)' },
      { offset: 0.3, transform: 'rotate(0deg)' },
      { offset: 0.88, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('left-bicep', musclePulse, { duration, easing: 'ease-in-out' }),
    animatePart('right-bicep', musclePulse, { duration, easing: 'ease-in-out' }),
    animatePart('left-bicep-crease', creasePulse, { duration, easing: 'ease-in-out' }),
    animatePart('right-bicep-crease', creasePulse, { duration, easing: 'ease-in-out' }),
    animatePart('left-leg', [
      { transform: 'rotate(0deg)' },
      { offset: 0.2, transform: 'rotate(-6deg)' },
      { offset: 0.88, transform: 'rotate(-6deg)' },
      { transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' }),
    animatePart('right-leg', [
      { transform: 'rotate(0deg)' },
      { offset: 0.2, transform: 'rotate(6deg)' },
      { offset: 0.88, transform: 'rotate(6deg)' },
      { transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' }),
    animatePart('left-shin', [
      { transform: 'rotate(0deg)' },
      { offset: 0.2, transform: 'rotate(8deg)' },
      { offset: 0.88, transform: 'rotate(8deg)' },
      { transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' }),
    animatePart('right-shin', [
      { transform: 'rotate(0deg)' },
      { offset: 0.2, transform: 'rotate(-8deg)' },
      { offset: 0.88, transform: 'rotate(-8deg)' },
      { transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' })
  ].filter(Boolean);
}

function playSelfie(context) {
  const { motion, animatePart } = context;
  const duration = 1120;
  return [
    context.animate(motion, [
      { offset: 0, transform: 'translate3d(0, 0, 0) rotate(0deg)' },
      { offset: 0.22, transform: 'translate3d(3%, -2%, 0) rotate(3deg)' },
      { offset: 0.78, transform: 'translate3d(3%, -2%, 0) rotate(3deg)' },
      { offset: 1, transform: 'translate3d(0, 0, 0) rotate(0deg)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('right-arm', [
      { offset: 0, transform: 'rotate(12deg)' },
      { offset: 0.24, transform: 'rotate(-3deg)' },
      { offset: 0.78, transform: 'rotate(-3deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' }),
    animatePart('right-forearm', [
      { offset: 0, transform: 'rotate(18deg)' },
      { offset: 0.24, transform: 'rotate(0deg)' },
      { offset: 0.78, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' }),
    animatePart('left-arm', [
      { offset: 0, transform: 'rotate(-12deg)' },
      { offset: 0.28, transform: 'rotate(3deg)' },
      { offset: 0.78, transform: 'rotate(3deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' }),
    animatePart('left-forearm', [
      { offset: 0, transform: 'rotate(-14deg)' },
      { offset: 0.28, transform: 'rotate(0deg)' },
      { offset: 0.78, transform: 'rotate(0deg)' },
      { offset: 1, transform: 'rotate(0deg)' }
    ], { duration, easing: 'ease-in-out' }),
    animatePart('phone', [
      { offset: 0, opacity: 0, transform: 'translate3d(-6px, 8px, 0) rotate(-14deg) scale(0.84)' },
      { offset: 0.2, opacity: 1, transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)' },
      { offset: 0.8, opacity: 1, transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)' },
      { offset: 1, opacity: 0, transform: 'translate3d(-3px, 4px, 0) rotate(-7deg) scale(0.92)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('peace-sign', [
      { offset: 0, opacity: 0, transform: 'scale(0.7) rotate(-12deg)' },
      { offset: 0.26, opacity: 0, transform: 'scale(0.7) rotate(-12deg)' },
      { offset: 0.38, opacity: 1, transform: 'scale(1) rotate(0deg)' },
      { offset: 0.8, opacity: 1, transform: 'scale(1) rotate(0deg)' },
      { offset: 1, opacity: 0, transform: 'scale(0.82) rotate(-7deg)' }
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
    animatePart('camera-flash', [
      { offset: 0, opacity: 0, transform: 'scale(0.42)' },
      { offset: 0.51, opacity: 0, transform: 'scale(0.42)' },
      { offset: 0.58, opacity: 0.72, transform: 'scale(0.72)' },
      { offset: 0.72, opacity: 0, transform: 'scale(1.65)' },
      { offset: 1, opacity: 0, transform: 'scale(1.65)' }
    ], { duration, easing: 'ease-out' })
  ].filter(Boolean);
}

export const HARP_TRICKS = Object.freeze({
  backflip: Object.freeze({
    duration: 1160,
    motionOrigin: '48% 54%',
    requiredParts: HARP_TRICK_REQUIRED_PARTS.backflip,
    play: playBackflip
  }),
  spin: Object.freeze({
    duration: 1020,
    motionOrigin: '50% 60%',
    requiredParts: HARP_TRICK_REQUIRED_PARTS.spin,
    play: playSpin
  }),
  flex: Object.freeze({
    duration: 1120,
    motionOrigin: '50% 66%',
    requiredParts: HARP_TRICK_REQUIRED_PARTS.flex,
    play: playFlex
  }),
  selfie: Object.freeze({
    duration: 1120,
    motionOrigin: '50% 66%',
    requiredParts: HARP_TRICK_REQUIRED_PARTS.selfie,
    play: playSelfie
  })
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
      delete root.dataset.harpPhase;
    } else {
      root?.removeAttribute?.('data-harp-trick');
      root?.removeAttribute?.('data-harp-phase');
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
    const trickDefinition = HARP_TRICKS[trickName];
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
    root.dataset.harpPhase = 'emergence';
    scale.style.setProperty('transform-origin', '50% 100%');
    scale.style.setProperty('will-change', 'transform');
    motion.style.setProperty('transform-origin', trickDefinition?.motionOrigin || '50% 60%');
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
    ], { duration: 130, easing: 'ease-out' }));

    const limbPaths = groups
      .flatMap((group) => Array.from(group.querySelectorAll('[data-limb]')))
      .sort((left, right) => Number(left.getAttribute('data-growth-order') || 0) - Number(right.getAttribute('data-growth-order') || 0));
    limbPaths.forEach((limb) => {
      const growthOrder = Number(limb.getAttribute('data-growth-order') || 0);
      records.push(startAnimation(limb, [
        { opacity: 0.25, strokeDasharray: '1', strokeDashoffset: '1' },
        { opacity: 1, strokeDasharray: '1', strokeDashoffset: '0' }
      ], {
        delay: growthOrder * 48,
        duration: growthOrder === 0 ? 178 : 188,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      }));
    });

    groups
      .flatMap((group) => Array.from(group.querySelectorAll('[data-extremity]')))
      .sort((left, right) => Number(left.getAttribute('data-growth-order') || 0) - Number(right.getAttribute('data-growth-order') || 0))
      .forEach((extremity) => {
        const growthOrder = Number(extremity.getAttribute('data-growth-order') || 0);
        records.push(startAnimation(extremity, [
          { opacity: 0 },
          { offset: 0.38, opacity: 0 },
          { opacity: 1 }
        ], {
          delay: growthOrder === 2 ? 124 : 70,
          duration: growthOrder === 2 ? 110 : 142,
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
    ], { delay: 112, duration: 133, easing: 'ease-in' }));

    groups
      .flatMap((group) => Array.from(group.querySelectorAll('[data-limb]')))
      .sort((left, right) => Number(right.getAttribute('data-growth-order') || 0) - Number(left.getAttribute('data-growth-order') || 0))
      .forEach((limb) => {
        const growthOrder = Number(limb.getAttribute('data-growth-order') || 0);
        records.push(startAnimation(limb, [
          { opacity: 1, strokeDasharray: '1', strokeDashoffset: '0' },
          { opacity: 0.2, strokeDasharray: '1', strokeDashoffset: '1' }
        ], {
          delay: growthOrder === 1 ? 0 : 48,
          duration: growthOrder === 1 ? 174 : 188,
          easing: 'cubic-bezier(0.4, 0, 1, 1)'
        }));
      });

    groups
      .flatMap((group) => Array.from(group.querySelectorAll('[data-extremity]')))
      .sort((left, right) => Number(right.getAttribute('data-growth-order') || 0) - Number(left.getAttribute('data-growth-order') || 0))
      .forEach((extremity) => {
        const growthOrder = Number(extremity.getAttribute('data-growth-order') || 0);
        records.push(startAnimation(extremity, [
          { opacity: 1 },
          { offset: 0.38, opacity: 1 },
          { opacity: 0 }
        ], {
          delay: growthOrder === 2 ? 0 : 34,
          duration: growthOrder === 2 ? 104 : 126,
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
    const trickDefinition = HARP_TRICKS[selectedTrick];
    const hasCompleteRig = trickDefinition.requiredParts.every((partName) => findPart(groups, partName));
    if (!hasCompleteRig) {
      neutralize();
      return null;
    }
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

      root.dataset.harpPhase = 'choreography';
      const performed = await waitForAnimations(trickDefinition.play(context));
      if (!performed || currentRunId !== runId) {
        return null;
      }

      root.dataset.harpPhase = 'retraction';
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
