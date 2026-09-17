// GENERATED FILE. Run `pnpm build:data` to regenerate; do not edit by hand.
import type { Content } from '../types';

export const content: Content = {
  "classes": {
    "arcanist": {
      "armorDef": 4,
      "armorMdef": 8,
      "attributes": {
        "agi": 1,
        "dex": 6,
        "int": 16,
        "luk": 1,
        "str": 1,
        "vit": 6
      },
      "baseHp": 60,
      "baseMp": 80,
      "basicIntervalMs": 1900,
      "basicKind": "magic",
      "basicRange": 4,
      "hpPerLevel": 9,
      "id": "arcanist",
      "level": 10,
      "mpPerLevel": 9,
      "skills": [
        "fire-bolt",
        "frost-nova"
      ],
      "weaponAtk": 5,
      "weaponMatk": 25
    },
    "cleric": {
      "armorDef": 5,
      "armorMdef": 8,
      "attributes": {
        "agi": 1,
        "dex": 1,
        "int": 16,
        "luk": 1,
        "str": 1,
        "vit": 6
      },
      "baseHp": 70,
      "baseMp": 70,
      "basicIntervalMs": 1800,
      "basicKind": "magic",
      "basicRange": 4,
      "hpPerLevel": 10,
      "id": "cleric",
      "level": 10,
      "mpPerLevel": 8,
      "skills": [
        "heal",
        "smite"
      ],
      "weaponAtk": 10,
      "weaponMatk": 22
    },
    "guardian": {
      "armorDef": 12,
      "armorMdef": 3,
      "attributes": {
        "agi": 1,
        "dex": 6,
        "int": 1,
        "luk": 1,
        "str": 11,
        "vit": 11
      },
      "baseHp": 100,
      "baseMp": 30,
      "basicIntervalMs": 1600,
      "basicKind": "physical",
      "basicRange": 1,
      "hpPerLevel": 15,
      "id": "guardian",
      "level": 10,
      "mpPerLevel": 3,
      "skills": [
        "taunt",
        "cleave"
      ],
      "weaponAtk": 25,
      "weaponMatk": 0
    },
    "ranger": {
      "armorDef": 6,
      "armorMdef": 3,
      "attributes": {
        "agi": 6,
        "dex": 16,
        "int": 1,
        "luk": 1,
        "str": 1,
        "vit": 6
      },
      "baseHp": 80,
      "baseMp": 40,
      "basicIntervalMs": 1400,
      "basicKind": "physical",
      "basicRange": 4,
      "hpPerLevel": 11,
      "id": "ranger",
      "level": 10,
      "mpPerLevel": 5,
      "skills": [
        "double-shot",
        "arrow-rain"
      ],
      "weaponAtk": 28,
      "weaponMatk": 0
    }
  },
  "elements": {
    "earth": {
      "earth": 10000,
      "fire": 7500,
      "neutral": 10000,
      "water": 10000,
      "wind": 15000
    },
    "fire": {
      "earth": 15000,
      "fire": 10000,
      "neutral": 10000,
      "water": 7500,
      "wind": 10000
    },
    "neutral": {
      "earth": 10000,
      "fire": 10000,
      "neutral": 10000,
      "water": 10000,
      "wind": 10000
    },
    "water": {
      "earth": 10000,
      "fire": 15000,
      "neutral": 10000,
      "water": 10000,
      "wind": 7500
    },
    "wind": {
      "earth": 7500,
      "fire": 10000,
      "neutral": 10000,
      "water": 15000,
      "wind": 10000
    }
  },
  "encounterLimitMs": 120000,
  "grid": {
    "enemyRows": [
      0,
      1
    ],
    "height": 5,
    "maxEnemies": 5,
    "moveMs": 500,
    "playerRows": [
      3,
      4
    ],
    "width": 5
  },
  "gridHash": "c2c839371c6faddb0756adef80f3fcb3d17c841fef809acc419dea7ddb43e4b9",
  "monsters": {
    "briar-boar": {
      "atk": 26,
      "def": 10,
      "element": "earth",
      "family": "beast",
      "flee": 14,
      "hit": 18,
      "hp": 180,
      "id": "briar-boar",
      "intervalMs": 1800,
      "level": 10,
      "matk": 0,
      "mdef": 4,
      "mp": 0,
      "range": 1,
      "rawExp": 30,
      "rawGold": 3
    },
    "mossling": {
      "atk": 16,
      "def": 3,
      "element": "earth",
      "family": "plant",
      "flee": 12,
      "hit": 16,
      "hp": 75,
      "id": "mossling",
      "intervalMs": 1700,
      "level": 10,
      "matk": 0,
      "mdef": 3,
      "mp": 0,
      "range": 1,
      "rawExp": 18,
      "rawGold": 2
    },
    "reed-slinger": {
      "atk": 22,
      "def": 4,
      "element": "wind",
      "family": "plant",
      "flee": 16,
      "hit": 22,
      "hp": 110,
      "id": "reed-slinger",
      "intervalMs": 2000,
      "level": 10,
      "matk": 0,
      "mdef": 6,
      "mp": 0,
      "range": 4,
      "rawExp": 30,
      "rawGold": 3
    }
  },
  "recipes": {
    "clustered": {
      "id": "clustered",
      "monsters": [
        {
          "column": 1,
          "monsterId": "mossling",
          "row": 0
        },
        {
          "column": 2,
          "monsterId": "mossling",
          "row": 0
        },
        {
          "column": 3,
          "monsterId": "mossling",
          "row": 0
        },
        {
          "column": 1,
          "monsterId": "mossling",
          "row": 1
        },
        {
          "column": 2,
          "monsterId": "mossling",
          "row": 1
        }
      ],
      "weight": 1
    },
    "melee": {
      "id": "melee",
      "monsters": [
        {
          "column": 1,
          "monsterId": "briar-boar",
          "row": 1
        },
        {
          "column": 2,
          "monsterId": "briar-boar",
          "row": 1
        },
        {
          "column": 3,
          "monsterId": "briar-boar",
          "row": 1
        }
      ],
      "weight": 1
    },
    "ranged": {
      "id": "ranged",
      "monsters": [
        {
          "column": 2,
          "monsterId": "briar-boar",
          "row": 1
        },
        {
          "column": 0,
          "monsterId": "reed-slinger",
          "row": 0
        },
        {
          "column": 4,
          "monsterId": "reed-slinger",
          "row": 0
        }
      ],
      "weight": 1
    }
  },
  "regenMs": 5000,
  "respawnMs": 30000,
  "shapes": {
    "cleave": [
      [
        -1,
        0
      ],
      [
        0,
        0
      ],
      [
        1,
        0
      ]
    ],
    "plus": [
      [
        0,
        0
      ],
      [
        -1,
        0
      ],
      [
        1,
        0
      ],
      [
        0,
        -1
      ],
      [
        0,
        1
      ]
    ],
    "single": [
      [
        0,
        0
      ]
    ],
    "square": [
      [
        0,
        0
      ],
      [
        1,
        0
      ],
      [
        0,
        1
      ],
      [
        1,
        1
      ]
    ]
  },
  "skills": {
    "arrow-rain": {
      "baseCastMs": 700,
      "cooldownMs": 6000,
      "damageKind": "physical",
      "durationMs": 0,
      "effect": "damage",
      "element": "neutral",
      "hits": 1,
      "id": "arrow-rain",
      "mp": 12,
      "powerBp": 8000,
      "range": 4,
      "shape": "square",
      "slowBp": 0
    },
    "cleave": {
      "baseCastMs": 0,
      "cooldownMs": 4000,
      "damageKind": "physical",
      "durationMs": 0,
      "effect": "damage",
      "element": "neutral",
      "hits": 1,
      "id": "cleave",
      "mp": 6,
      "powerBp": 12000,
      "range": 1,
      "shape": "cleave",
      "slowBp": 0
    },
    "double-shot": {
      "baseCastMs": 0,
      "cooldownMs": 3000,
      "damageKind": "physical",
      "durationMs": 0,
      "effect": "damage",
      "element": "neutral",
      "hits": 2,
      "id": "double-shot",
      "mp": 6,
      "powerBp": 7000,
      "range": 4,
      "shape": "single",
      "slowBp": 0
    },
    "fire-bolt": {
      "baseCastMs": 900,
      "cooldownMs": 3000,
      "damageKind": "magic",
      "durationMs": 0,
      "effect": "damage",
      "element": "fire",
      "hits": 1,
      "id": "fire-bolt",
      "mp": 8,
      "powerBp": 13000,
      "range": 4,
      "shape": "single",
      "slowBp": 0
    },
    "frost-nova": {
      "baseCastMs": 900,
      "cooldownMs": 6000,
      "damageKind": "magic",
      "durationMs": 5000,
      "effect": "damage",
      "element": "water",
      "hits": 1,
      "id": "frost-nova",
      "mp": 12,
      "powerBp": 8000,
      "range": 4,
      "shape": "plus",
      "slowBp": 3000
    },
    "heal": {
      "baseCastMs": 800,
      "cooldownMs": 2500,
      "damageKind": "magic",
      "durationMs": 0,
      "effect": "heal",
      "element": "neutral",
      "hits": 1,
      "id": "heal",
      "mp": 8,
      "powerBp": 0,
      "range": 4,
      "shape": "single",
      "slowBp": 0
    },
    "smite": {
      "baseCastMs": 600,
      "cooldownMs": 3000,
      "damageKind": "magic",
      "durationMs": 0,
      "effect": "damage",
      "element": "neutral",
      "hits": 1,
      "id": "smite",
      "mp": 7,
      "powerBp": 10000,
      "range": 4,
      "shape": "single",
      "slowBp": 0
    },
    "taunt": {
      "baseCastMs": 0,
      "cooldownMs": 8000,
      "damageKind": "magic",
      "durationMs": 4000,
      "effect": "taunt",
      "element": "neutral",
      "hits": 1,
      "id": "taunt",
      "mp": 8,
      "powerBp": 0,
      "range": 4,
      "shape": "single",
      "slowBp": 0
    }
  },
  "version": "d32c6cd45b1ee49eae6ab0f3fa5f1d4b5a1ab657bb9dc18a4db18c7da50816ef",
  "walkMs": 2000
};
