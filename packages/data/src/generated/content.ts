// GENERATED FILE. Run `pnpm build:data` to regenerate; do not edit by hand.
import type { Content } from '../types';

export const content: Content = {
  "bonuses": {
    "agi": {
      "attribute": "agi",
      "element": null,
      "family": null,
      "id": "agi",
      "kind": "attribute",
      "slots": [
        "weapon",
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 3,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "atk-pct": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "atk-pct",
      "kind": "atk-pct",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 300,
          "min": 100
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "attack-speed": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "attack-speed",
      "kind": "attack-speed",
      "slots": [
        "weapon",
        "shoes",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "max",
      "unit": "bp"
    },
    "beast-damage": {
      "attribute": null,
      "element": null,
      "family": "beast",
      "id": "beast-damage",
      "kind": "family-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "crit": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "crit",
      "kind": "crit",
      "slots": [
        "weapon",
        "head",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 300,
          "min": 100
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "demon-damage": {
      "attribute": null,
      "element": null,
      "family": "demon",
      "id": "demon-damage",
      "kind": "family-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "dex": {
      "attribute": "dex",
      "element": null,
      "family": null,
      "id": "dex",
      "kind": "attribute",
      "slots": [
        "weapon",
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 3,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "earth-damage": {
      "attribute": null,
      "element": "earth",
      "family": null,
      "id": "earth-damage",
      "kind": "element-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "earth-resist": {
      "attribute": null,
      "element": "earth",
      "family": null,
      "id": "earth-resist",
      "kind": "element-resist",
      "slots": [
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes"
      ],
      "spans": [
        {
          "max": 800,
          "min": 300
        }
      ],
      "stacking": "max",
      "unit": "bp"
    },
    "fire-damage": {
      "attribute": null,
      "element": "fire",
      "family": null,
      "id": "fire-damage",
      "kind": "element-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "fire-resist": {
      "attribute": null,
      "element": "fire",
      "family": null,
      "id": "fire-resist",
      "kind": "element-resist",
      "slots": [
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes"
      ],
      "spans": [
        {
          "max": 800,
          "min": 300
        }
      ],
      "stacking": "max",
      "unit": "bp"
    },
    "heal-power": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "heal-power",
      "kind": "heal-power",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "hp-regen": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "hp-regen",
      "kind": "hp-regen",
      "slots": [
        "body",
        "cloak",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 3,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "humanoid-damage": {
      "attribute": null,
      "element": null,
      "family": "humanoid",
      "id": "humanoid-damage",
      "kind": "family-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "insect-damage": {
      "attribute": null,
      "element": null,
      "family": "insect",
      "id": "insect-damage",
      "kind": "family-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "int": {
      "attribute": "int",
      "element": null,
      "family": null,
      "id": "int",
      "kind": "attribute",
      "slots": [
        "weapon",
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 3,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "luk": {
      "attribute": "luk",
      "element": null,
      "family": null,
      "id": "luk",
      "kind": "attribute",
      "slots": [
        "weapon",
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 3,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "matk-pct": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "matk-pct",
      "kind": "matk-pct",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 300,
          "min": 100
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "max-hp": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "max-hp",
      "kind": "max-hp",
      "slots": [
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "mp-regen": {
      "attribute": null,
      "element": null,
      "family": null,
      "id": "mp-regen",
      "kind": "mp-regen",
      "slots": [
        "head",
        "cloak",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 2,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "plant-damage": {
      "attribute": null,
      "element": null,
      "family": "plant",
      "id": "plant-damage",
      "kind": "family-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "str": {
      "attribute": "str",
      "element": null,
      "family": null,
      "id": "str",
      "kind": "attribute",
      "slots": [
        "weapon",
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 3,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "undead-damage": {
      "attribute": null,
      "element": null,
      "family": "undead",
      "id": "undead-damage",
      "kind": "family-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "vit": {
      "attribute": "vit",
      "element": null,
      "family": null,
      "id": "vit",
      "kind": "attribute",
      "slots": [
        "weapon",
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 3,
          "min": 1
        }
      ],
      "stacking": "sum",
      "unit": "flat"
    },
    "water-damage": {
      "attribute": null,
      "element": "water",
      "family": null,
      "id": "water-damage",
      "kind": "element-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "water-resist": {
      "attribute": null,
      "element": "water",
      "family": null,
      "id": "water-resist",
      "kind": "element-resist",
      "slots": [
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes"
      ],
      "spans": [
        {
          "max": 800,
          "min": 300
        }
      ],
      "stacking": "max",
      "unit": "bp"
    },
    "wind-damage": {
      "attribute": null,
      "element": "wind",
      "family": null,
      "id": "wind-damage",
      "kind": "element-damage",
      "slots": [
        "weapon",
        "accessory1",
        "accessory2"
      ],
      "spans": [
        {
          "max": 500,
          "min": 200
        }
      ],
      "stacking": "sum",
      "unit": "bp"
    },
    "wind-resist": {
      "attribute": null,
      "element": "wind",
      "family": null,
      "id": "wind-resist",
      "kind": "element-resist",
      "slots": [
        "offhand",
        "head",
        "body",
        "cloak",
        "shoes"
      ],
      "spans": [
        {
          "max": 800,
          "min": 300
        }
      ],
      "stacking": "max",
      "unit": "bp"
    }
  },
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
  "items": {
    "arcanist-staff": {
      "armorDef": 0,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": 1900,
      "basicKind": "magic",
      "basicRange": 4,
      "classes": [
        "arcanist"
      ],
      "fittingBonuses": [
        "int",
        "matk-pct"
      ],
      "handedness": "two-handed",
      "id": "arcanist-staff",
      "levelRequirement": 1,
      "slot": "weapon",
      "tier": 1,
      "weaponAtk": 5,
      "weaponMatk": 25
    },
    "bone-charm": {
      "armorDef": 0,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": null,
      "basicKind": null,
      "basicRange": null,
      "classes": null,
      "fittingBonuses": [
        "dex",
        "hp-regen"
      ],
      "handedness": "none",
      "id": "bone-charm",
      "levelRequirement": 1,
      "slot": "accessory2",
      "tier": 1,
      "weaponAtk": 0,
      "weaponMatk": 0
    },
    "cleric-mace": {
      "armorDef": 0,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": 1800,
      "basicKind": "magic",
      "basicRange": 4,
      "classes": [
        "cleric"
      ],
      "fittingBonuses": [
        "heal-power",
        "int"
      ],
      "handedness": "one-handed",
      "id": "cleric-mace",
      "levelRequirement": 1,
      "slot": "weapon",
      "tier": 1,
      "weaponAtk": 10,
      "weaponMatk": 22
    },
    "copper-ring": {
      "armorDef": 0,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": null,
      "basicKind": null,
      "basicRange": null,
      "classes": null,
      "fittingBonuses": [
        "luk",
        "crit"
      ],
      "handedness": "none",
      "id": "copper-ring",
      "levelRequirement": 1,
      "slot": "accessory1",
      "tier": 1,
      "weaponAtk": 0,
      "weaponMatk": 0
    },
    "guardian-sword": {
      "armorDef": 0,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": 1600,
      "basicKind": "physical",
      "basicRange": 1,
      "classes": [
        "guardian"
      ],
      "fittingBonuses": [
        "str",
        "atk-pct"
      ],
      "handedness": "one-handed",
      "id": "guardian-sword",
      "levelRequirement": 1,
      "slot": "weapon",
      "tier": 1,
      "weaponAtk": 25,
      "weaponMatk": 0
    },
    "leather-boots": {
      "armorDef": 1,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": null,
      "basicKind": null,
      "basicRange": null,
      "classes": null,
      "fittingBonuses": [
        "agi",
        "attack-speed"
      ],
      "handedness": "none",
      "id": "leather-boots",
      "levelRequirement": 1,
      "slot": "shoes",
      "tier": 1,
      "weaponAtk": 0,
      "weaponMatk": 0
    },
    "leather-cap": {
      "armorDef": 1,
      "armorMdef": 1,
      "basePrice": null,
      "basicIntervalMs": null,
      "basicKind": null,
      "basicRange": null,
      "classes": null,
      "fittingBonuses": [
        "int",
        "mp-regen"
      ],
      "handedness": "none",
      "id": "leather-cap",
      "levelRequirement": 1,
      "slot": "head",
      "tier": 1,
      "weaponAtk": 0,
      "weaponMatk": 0
    },
    "padded-vest": {
      "armorDef": 3,
      "armorMdef": 1,
      "basePrice": null,
      "basicIntervalMs": null,
      "basicKind": null,
      "basicRange": null,
      "classes": null,
      "fittingBonuses": [
        "vit",
        "max-hp"
      ],
      "handedness": "none",
      "id": "padded-vest",
      "levelRequirement": 1,
      "slot": "body",
      "tier": 1,
      "weaponAtk": 0,
      "weaponMatk": 0
    },
    "ranger-bow": {
      "armorDef": 0,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": 1400,
      "basicKind": "physical",
      "basicRange": 4,
      "classes": [
        "ranger"
      ],
      "fittingBonuses": [
        "dex",
        "crit"
      ],
      "handedness": "two-handed",
      "id": "ranger-bow",
      "levelRequirement": 1,
      "slot": "weapon",
      "tier": 1,
      "weaponAtk": 28,
      "weaponMatk": 0
    },
    "wooden-buckler": {
      "armorDef": 2,
      "armorMdef": 0,
      "basePrice": null,
      "basicIntervalMs": null,
      "basicKind": null,
      "basicRange": null,
      "classes": null,
      "fittingBonuses": [
        "vit",
        "max-hp"
      ],
      "handedness": "offhand",
      "id": "wooden-buckler",
      "levelRequirement": 1,
      "slot": "offhand",
      "tier": 1,
      "weaponAtk": 0,
      "weaponMatk": 0
    },
    "wool-cloak": {
      "armorDef": 1,
      "armorMdef": 1,
      "basePrice": null,
      "basicIntervalMs": null,
      "basicKind": null,
      "basicRange": null,
      "classes": null,
      "fittingBonuses": [
        "agi",
        "hp-regen"
      ],
      "handedness": "none",
      "id": "wool-cloak",
      "levelRequirement": 1,
      "slot": "cloak",
      "tier": 1,
      "weaponAtk": 0,
      "weaponMatk": 0
    }
  },
  "monsters": {
    "briar-boar": {
      "atk": 26,
      "consumables": [],
      "def": 10,
      "dropMultiplier": 1,
      "element": "earth",
      "equipment": [
        "arcanist-staff",
        "bone-charm",
        "cleric-mace",
        "copper-ring",
        "guardian-sword",
        "leather-boots",
        "leather-cap",
        "padded-vest",
        "ranger-bow",
        "wooden-buckler",
        "wool-cloak"
      ],
      "family": "beast",
      "flee": 14,
      "goldMax": 3,
      "goldMin": 3,
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
      "consumables": [],
      "def": 3,
      "dropMultiplier": 1,
      "element": "earth",
      "equipment": [
        "arcanist-staff",
        "bone-charm",
        "cleric-mace",
        "copper-ring",
        "guardian-sword",
        "leather-boots",
        "leather-cap",
        "padded-vest",
        "ranger-bow",
        "wooden-buckler",
        "wool-cloak"
      ],
      "family": "plant",
      "flee": 12,
      "goldMax": 2,
      "goldMin": 2,
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
      "consumables": [],
      "def": 4,
      "dropMultiplier": 1,
      "element": "wind",
      "equipment": [
        "arcanist-staff",
        "bone-charm",
        "cleric-mace",
        "copper-ring",
        "guardian-sword",
        "leather-boots",
        "leather-cap",
        "padded-vest",
        "ranger-bow",
        "wooden-buckler",
        "wool-cloak"
      ],
      "family": "plant",
      "flee": 16,
      "goldMax": 3,
      "goldMin": 3,
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
  "onboardingGrant": {
    "arcanist": {
      "bonuses": [
        {
          "bonusId": "int",
          "value": 3
        }
      ],
      "definitionId": "arcanist-staff",
      "itemLevel": 1,
      "rarity": "uncommon"
    },
    "cleric": {
      "bonuses": [
        {
          "bonusId": "heal-power",
          "value": 500
        }
      ],
      "definitionId": "cleric-mace",
      "itemLevel": 1,
      "rarity": "uncommon"
    },
    "guardian": {
      "bonuses": [
        {
          "bonusId": "str",
          "value": 3
        }
      ],
      "definitionId": "guardian-sword",
      "itemLevel": 1,
      "rarity": "uncommon"
    },
    "ranger": {
      "bonuses": [
        {
          "bonusId": "dex",
          "value": 3
        }
      ],
      "definitionId": "ranger-bow",
      "itemLevel": 1,
      "rarity": "uncommon"
    }
  },
  "pity": {
    "epicPlusThreshold": null,
    "guaranteeEnabled": false,
    "legendaryThreshold": null
  },
  "rarities": {
    "common": {
      "bonusCount": 0,
      "ppm": 5000,
      "protected": false
    },
    "epic": {
      "bonusCount": 3,
      "ppm": 100,
      "protected": false
    },
    "legendary": {
      "bonusCount": 4,
      "ppm": 10,
      "protected": true
    },
    "rare": {
      "bonusCount": 2,
      "ppm": 500,
      "protected": false
    },
    "uncommon": {
      "bonusCount": 1,
      "ppm": 2000,
      "protected": false
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
  "townReturnTravelMs": 10000,
  "version": "e8a38194c476e8b7bbb2b4e428f4a578b22ec1101f8caf2bff6fd0f318d0c035",
  "walkMs": 2000
};
