/**
 * 常见食物营养数据（每 100 克可食部）
 *
 * 数据来源与准确度说明（重要，别当成精确值用）：
 *  - 大部分条目参考《中国食物成分表（第 6 版）》，少部分按更贴近实际吃到的口径：
 *    全脂牛奶按中国市售包装标签（65 kcal/100ml，比成分表的 54 更接近日常喝的）；
 *    鸡胸肉、红薯、西兰花、三文鱼按 USDA FoodData Central（更接近去皮去骨/养殖的实际值）。
 *    两张表的口径差异可达 ±20%，所以本表只当估算。
 *  - 生熟状态差别很大。主食明确区分生熟（米饭、面条按熟重计）；
 *    肉/鱼/虾 v30 起也拆成「熟重」和「生重」两条：默认匹配「鸡胸肉」「虾」会落到**熟重**那条
 *    （大多数人估份量、称重都是做熟之后的重量），说「生鸡胸肉」「生重」才落到生重那条。
 *    熟重不是另抄一套成分数据，而是按烹饪失水折算：**肉类约 ×0.75（失水约 25%）**；
 *    鱼虾按各自实际（三文鱼熟重≈生重、虾约 +6%），不是统一乘 0.75。
 *  - 品牌、做法、放油量都会让真实值上下浮动 10%~30%，尤其是炒菜和外卖。
 *  - 包装食品别借用相近的食材条目（预制调理鸡胸 vs 生鸡胸能差 40%）：
 *    用「记录 → 找不到？自己加 → 照包装营养成分表填」，数字就是包装上的。
 *  - 自检规则：蛋白×4 + 脂肪×9 + 碳水×4 应当接近标称热量（含酒精的饮品除外）。
 */

import { DISHES, dishAsFood } from './dishes.js';

export const FOOD_CATEGORIES = [
  { key: 'staple', label: '主食' },
  { key: 'protein', label: '肉蛋豆' },
  { key: 'dairy', label: '奶类' },
  { key: 'vegetable', label: '蔬菜' },
  { key: 'fruit', label: '水果' },
  { key: 'fat', label: '坚果油脂' },
  { key: 'drink', label: '饮料' },
  { key: 'snack', label: '零食甜品' },
  { key: 'dish', label: '家常菜/外食' },
];

/** servings: [名称, 克数]，用来把「一碗」「一个」换算成克 */
export const FOODS = [
  // ── 主食 ──────────────────────────────────────────────
  { id: 'rice_cooked', name: '米饭（熟）', category: 'staple', kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9, servings: [['一小碗', 130], ['一碗', 180], ['一大碗', 250]] },
  { id: 'rice_raw', name: '大米（生）', category: 'staple', kcal: 346, protein: 7.4, fat: 0.8, carb: 77.9, servings: [['一量杯', 150]] },
  { id: 'congee', name: '白粥', category: 'staple', kcal: 46, protein: 1.1, fat: 0.3, carb: 9.9, servings: [['一碗', 250], ['一小碗', 180]] },
  { id: 'bun', name: '馒头', category: 'staple', kcal: 223, protein: 7.0, fat: 1.1, carb: 47.0, servings: [['一个', 100], ['半个', 50]] },
  { id: 'baozi_pork', name: '猪肉包子', category: 'staple', kcal: 227, protein: 8.0, fat: 7.0, carb: 32.0, servings: [['一个', 100]] },
  { id: 'noodle_cooked', name: '面条（煮熟）', category: 'staple', kcal: 110, protein: 3.6, fat: 0.4, carb: 23.0, servings: [['一碗', 250]] },
  { id: 'noodle_raw', name: '挂面（生）', category: 'staple', kcal: 348, protein: 11.0, fat: 0.7, carb: 74.5, servings: [['一小把', 80]] },
  { id: 'pasta_cooked', name: '意大利面（煮熟）', category: 'staple', kcal: 131, protein: 5.0, fat: 1.1, carb: 25.0, servings: [['一份', 200]] },
  { id: 'oats', name: '燕麦片（干）', category: 'staple', kcal: 377, protein: 15.0, fat: 6.7, carb: 61.0, servings: [['一勺', 30], ['一份', 50]] },
  { id: 'sweet_potato', name: '红薯（蒸）', category: 'staple', kcal: 90, protein: 1.6, fat: 0.2, carb: 20.7, servings: [['一个中', 150]] },
  { id: 'potato', name: '土豆（蒸）', category: 'staple', kcal: 81, protein: 2.0, fat: 0.2, carb: 17.8, servings: [['一个中', 150]] },
  { id: 'corn', name: '玉米（煮）', category: 'staple', kcal: 112, protein: 4.0, fat: 1.2, carb: 22.8, servings: [['一根', 200]] },
  { id: 'quinoa_cooked', name: '藜麦（熟）', category: 'staple', kcal: 120, protein: 4.4, fat: 1.9, carb: 21.3, servings: [['一份', 150]] },
  { id: 'rice_noodle', name: '米粉/河粉（熟）', category: 'staple', kcal: 109, protein: 1.6, fat: 0.3, carb: 25.0, servings: [['一碗', 250]] },
  { id: 'dumpling_pork', name: '猪肉水饺', category: 'staple', kcal: 240, protein: 9.0, fat: 9.0, carb: 30.0, servings: [['一个', 20], ['10 个', 200]] },

  // ── 肉蛋豆 ────────────────────────────────────────────
  // 生熟拆分（v30）：默认「鸡胸肉」= 熟重（做熟后的重量，普通人称/估的都是这个）；
  // 说「生鸡胸肉」「生重」才按生重算。熟重 = 生重按烹饪失水约 25% 折算，营养按同等可食部计。
  { id: 'chicken_breast_cooked', name: '鸡胸肉（熟重）', form: 'cooked', category: 'protein', kcal: 157, protein: 31.0, fat: 2.6, carb: 0.6, servings: [['一块', 150]] },
  { id: 'chicken_breast', name: '生鸡胸肉（去皮）', form: 'raw', category: 'protein', kcal: 118, protein: 24.0, fat: 1.9, carb: 0.6, servings: [['一块', 150]] },
  { id: 'chicken_thigh_cooked', name: '鸡腿肉（去皮，熟重）', form: 'cooked', category: 'protein', kcal: 193, protein: 25.0, fat: 9.0, carb: 0, servings: [['一个', 100]] },
  { id: 'chicken_thigh', name: '生鸡腿肉（去皮）', form: 'raw', category: 'protein', kcal: 145, protein: 19.0, fat: 7.0, carb: 0, servings: [['一个', 100]] },
  { id: 'chicken_wing', name: '鸡翅', category: 'protein', kcal: 194, protein: 17.4, fat: 11.8, carb: 4.6, servings: [['一个', 50]] },
  { id: 'chicken_skin', name: '炸鸡（带皮）', category: 'dish', kcal: 279, protein: 20.0, fat: 17.0, carb: 10.0, servings: [['一块', 100]] },
  { id: 'pork_lean_cooked', name: '猪瘦肉（熟重）', form: 'cooked', category: 'protein', kcal: 190, protein: 27.0, fat: 8.0, carb: 2.0, servings: [['一小份', 100]] },
  { id: 'pork_lean', name: '生猪瘦肉', form: 'raw', category: 'protein', kcal: 143, protein: 20.3, fat: 6.2, carb: 1.5, servings: [['一小份', 100]] },
  { id: 'pork_belly', name: '五花肉（生）', category: 'protein', kcal: 508, protein: 9.0, fat: 53.0, carb: 0, servings: [['一小份', 80]] },
  { id: 'pork_rib', name: '排骨（生）', category: 'protein', kcal: 278, protein: 18.0, fat: 23.0, carb: 1.0, servings: [['一根', 80]] },
  { id: 'beef_lean_cooked', name: '瘦牛肉（熟重）', form: 'cooked', category: 'protein', kcal: 167, protein: 27.0, fat: 5.6, carb: 1.6, servings: [['一小份', 120]] },
  { id: 'beef_lean', name: '生瘦牛肉', form: 'raw', category: 'protein', kcal: 125, protein: 20.2, fat: 4.2, carb: 1.2, servings: [['一小份', 120]] },
  { id: 'beef_fatty', name: '肥牛/雪花牛肉', category: 'protein', kcal: 300, protein: 16.0, fat: 26.0, carb: 0, servings: [['一份', 100]] },
  { id: 'lamb', name: '羊肉（瘦）', category: 'protein', kcal: 118, protein: 20.5, fat: 3.9, carb: 0.2, servings: [['一份', 100]] },
  { id: 'shrimp_cooked', name: '虾（熟重）', form: 'cooked', category: 'protein', kcal: 99, protein: 20.0, fat: 1.0, carb: 3.0, servings: [['一只', 15], ['10 只', 150]] },
  { id: 'shrimp', name: '生虾', form: 'raw', category: 'protein', kcal: 93, protein: 18.6, fat: 0.8, carb: 2.8, servings: [['一只', 15], ['10 只', 150]] },
  // 按养殖大西洋鲑（USDA FoodData Central 175167）：208/20.4/13.4。
  // 之前误用了《中国食物成分表》「鲑鱼（大马哈鱼）」的 139/17.2/7.8（野生太平洋鲑），每 100 克少算约 70 kcal
  { id: 'salmon_cooked', name: '三文鱼（熟重）', form: 'cooked', category: 'protein', kcal: 210, protein: 22.0, fat: 13.0, carb: 0.0, servings: [['一份', 120]] },
  { id: 'salmon', name: '生三文鱼（养殖）', form: 'raw', category: 'protein', kcal: 208, protein: 20.4, fat: 13.4, carb: 0.0, servings: [['一份', 120]] },
  { id: 'salmon_wild', name: '大马哈鱼（野生）', category: 'protein', kcal: 139, protein: 17.2, fat: 7.8, carb: 0.0, servings: [['一份', 120]] },
  { id: 'white_fish_cooked', name: '巴沙鱼/龙利鱼（熟重）', form: 'cooked', category: 'protein', kcal: 100, protein: 19.0, fat: 2.0, carb: 0, servings: [['一份', 150]] },
  { id: 'white_fish', name: '生巴沙鱼/龙利鱼', form: 'raw', category: 'protein', kcal: 90, protein: 17.0, fat: 2.0, carb: 0, servings: [['一份', 150]] },
  { id: 'tuna_can', name: '水浸金枪鱼罐头', category: 'protein', kcal: 100, protein: 22.0, fat: 1.0, carb: 0, servings: [['一罐', 120]] },
  { id: 'egg', name: '鸡蛋', category: 'protein', kcal: 143, protein: 13.3, fat: 8.8, carb: 2.8, servings: [['一个', 50], ['两个', 100], ['蛋白（一个）', 33], ['蛋黄（一个）', 17]] },
  { id: 'duck_egg', name: '鸭蛋', category: 'protein', kcal: 180, protein: 12.6, fat: 13.0, carb: 3.1, servings: [['一个', 70]] },
  { id: 'tofu_firm', name: '北豆腐（老豆腐）', category: 'protein', kcal: 99, protein: 12.2, fat: 4.8, carb: 2.0, servings: [['一块', 100]] },
  { id: 'tofu_silken', name: '南豆腐（嫩豆腐）', category: 'protein', kcal: 57, protein: 6.2, fat: 2.5, carb: 2.4, servings: [['一块', 100]] },
  { id: 'dried_tofu', name: '豆腐干', category: 'protein', kcal: 140, protein: 16.2, fat: 3.6, carb: 11.5, servings: [['一块', 50]] },
  { id: 'soybean', name: '黄豆（干）', category: 'protein', kcal: 390, protein: 35.0, fat: 16.0, carb: 34.2, servings: [['一小把', 30]] },
  { id: 'edamame', name: '毛豆', category: 'protein', kcal: 131, protein: 13.1, fat: 5.0, carb: 10.5, servings: [['一份', 100]] },

  // ── 奶类 ──────────────────────────────────────────────
  { id: 'milk_whole', name: '全脂牛奶', category: 'dairy', kcal: 65, protein: 3.3, fat: 3.6, carb: 4.9, servings: [['一杯', 250]] },
  { id: 'milk_skim', name: '脱脂/低脂牛奶', category: 'dairy', kcal: 35, protein: 3.4, fat: 0.4, carb: 4.9, servings: [['一杯', 250]] },
  { id: 'yogurt_plain', name: '无糖酸奶', category: 'dairy', kcal: 62, protein: 3.2, fat: 3.2, carb: 5.0, servings: [['一杯', 150]] },
  { id: 'yogurt_sweet', name: '含糖酸奶/风味酸奶', category: 'dairy', kcal: 90, protein: 2.9, fat: 2.7, carb: 13.5, servings: [['一杯', 150]] },
  { id: 'greek_yogurt', name: '希腊酸奶（无糖）', category: 'dairy', kcal: 90, protein: 9.0, fat: 4.5, carb: 3.6, servings: [['一杯', 150]] },
  { id: 'soy_milk', name: '无糖豆浆', category: 'dairy', kcal: 31, protein: 3.0, fat: 1.6, carb: 1.2, servings: [['一杯', 300]] },
  { id: 'cheese_slice', name: '芝士片', category: 'dairy', kcal: 330, protein: 20.0, fat: 26.0, carb: 3.0, servings: [['一片', 20]] },

  // ── 蔬菜 ──────────────────────────────────────────────
  { id: 'broccoli', name: '西兰花', category: 'vegetable', kcal: 36, protein: 4.1, fat: 0.6, carb: 4.3, servings: [['一份', 150]] },
  { id: 'spinach', name: '菠菜', category: 'vegetable', kcal: 28, protein: 2.6, fat: 0.3, carb: 4.5, servings: [['一份', 150]] },
  { id: 'bokchoy', name: '小白菜', category: 'vegetable', kcal: 15, protein: 1.5, fat: 0.3, carb: 2.7, servings: [['一份', 150]] },
  { id: 'lettuce', name: '生菜', category: 'vegetable', kcal: 16, protein: 1.3, fat: 0.3, carb: 2.0, servings: [['一份', 100]] },
  { id: 'cucumber', name: '黄瓜', category: 'vegetable', kcal: 16, protein: 0.8, fat: 0.2, carb: 2.9, servings: [['一根', 200]] },
  { id: 'tomato', name: '番茄', category: 'vegetable', kcal: 20, protein: 0.9, fat: 0.2, carb: 4.0, servings: [['一个', 150]] },
  { id: 'carrot', name: '胡萝卜', category: 'vegetable', kcal: 39, protein: 1.0, fat: 0.2, carb: 8.8, servings: [['一根', 120]] },
  // 香菇的碳水里含约 3.3g 膳食纤维，纤维几乎不产能，所以热量比 4/9/4 折算值低
  { id: 'mushroom', name: '香菇（鲜）', category: 'vegetable', kcal: 26, protein: 2.2, fat: 0.3, carb: 4.2, servings: [['一份', 100]] },
  { id: 'enoki', name: '金针菇', category: 'vegetable', kcal: 32, protein: 2.4, fat: 0.4, carb: 6.0, servings: [['一份', 100]] },
  { id: 'seaweed', name: '海带（鲜）', category: 'vegetable', kcal: 13, protein: 1.2, fat: 0.1, carb: 2.1, servings: [['一份', 100]] },
  { id: 'winter_melon', name: '冬瓜', category: 'vegetable', kcal: 12, protein: 0.4, fat: 0.2, carb: 2.4, servings: [['一份', 200]] },
  { id: 'bitter_melon', name: '苦瓜', category: 'vegetable', kcal: 22, protein: 1.0, fat: 0.2, carb: 4.9, servings: [['一份', 150]] },
  { id: 'eggplant', name: '茄子', category: 'vegetable', kcal: 23, protein: 1.1, fat: 0.2, carb: 4.9, servings: [['一份', 150]] },
  { id: 'bell_pepper', name: '青椒', category: 'vegetable', kcal: 22, protein: 1.0, fat: 0.2, carb: 4.0, servings: [['一个', 100]] },
  { id: 'cabbage', name: '卷心菜', category: 'vegetable', kcal: 24, protein: 1.5, fat: 0.2, carb: 4.6, servings: [['一份', 150]] },
  { id: 'chinese_cabbage', name: '大白菜', category: 'vegetable', kcal: 20, protein: 1.6, fat: 0.2, carb: 3.4, servings: [['一份', 200]] },

  // ── 水果 ──────────────────────────────────────────────
  { id: 'apple', name: '苹果', category: 'fruit', kcal: 53, protein: 0.4, fat: 0.2, carb: 13.7, servings: [['一个', 200]] },
  { id: 'banana', name: '香蕉', category: 'fruit', kcal: 93, protein: 1.4, fat: 0.2, carb: 22.0, servings: [['一根', 120]] },
  { id: 'orange', name: '橙子', category: 'fruit', kcal: 48, protein: 0.8, fat: 0.2, carb: 11.1, servings: [['一个', 180]] },
  { id: 'grape', name: '葡萄', category: 'fruit', kcal: 45, protein: 0.5, fat: 0.2, carb: 10.3, servings: [['一小串', 150]] },
  { id: 'watermelon', name: '西瓜', category: 'fruit', kcal: 31, protein: 0.5, fat: 0.3, carb: 7.0, servings: [['一块', 300]] },
  { id: 'strawberry', name: '草莓', category: 'fruit', kcal: 32, protein: 1.0, fat: 0.2, carb: 7.1, servings: [['一份', 150]] },
  { id: 'blueberry', name: '蓝莓', category: 'fruit', kcal: 57, protein: 0.7, fat: 0.3, carb: 14.5, servings: [['一份', 100]] },
  { id: 'pear', name: '梨', category: 'fruit', kcal: 51, protein: 0.4, fat: 0.2, carb: 13.3, servings: [['一个', 200]] },
  { id: 'peach', name: '桃子', category: 'fruit', kcal: 42, protein: 0.9, fat: 0.1, carb: 10.9, servings: [['一个', 150]] },
  { id: 'kiwi', name: '猕猴桃', category: 'fruit', kcal: 61, protein: 0.8, fat: 0.6, carb: 14.5, servings: [['一个', 100]] },
  { id: 'mango', name: '芒果', category: 'fruit', kcal: 35, protein: 0.6, fat: 0.2, carb: 8.3, servings: [['一个', 200]] },
  { id: 'durian', name: '榴莲', category: 'fruit', kcal: 150, protein: 2.6, fat: 3.3, carb: 28.3, servings: [['一块', 100]] },

  // ── 坚果油脂 ──────────────────────────────────────────
  { id: 'oil', name: '食用油（炒菜用）', category: 'fat', kcal: 899, protein: 0, fat: 99.9, carb: 0, servings: [['一勺', 10], ['一汤匙', 15], ['一份炒菜用油', 15]] },
  { id: 'peanut', name: '花生（炒）', category: 'fat', kcal: 589, protein: 24.0, fat: 48.0, carb: 21.7, servings: [['一小把', 25]] },
  { id: 'walnut', name: '核桃', category: 'fat', kcal: 654, protein: 15.2, fat: 65.0, carb: 13.7, servings: [['两个', 20]] },
  { id: 'almond', name: '巴旦木/杏仁', category: 'fat', kcal: 578, protein: 21.0, fat: 50.0, carb: 21.7, servings: [['一小把', 25]] },
  { id: 'cashew', name: '腰果', category: 'fat', kcal: 559, protein: 17.3, fat: 36.7, carb: 41.6, servings: [['一小把', 25]] },
  { id: 'peanut_butter', name: '花生酱（无糖）', category: 'fat', kcal: 600, protein: 25.0, fat: 50.0, carb: 22.0, servings: [['一勺', 15]] },
  { id: 'sesame_paste', name: '芝麻酱', category: 'fat', kcal: 630, protein: 19.2, fat: 52.7, carb: 22.7, servings: [['一勺', 15]] },
  { id: 'avocado', name: '牛油果', category: 'fat', kcal: 160, protein: 2.0, fat: 15.0, carb: 8.5, servings: [['一个', 150], ['半个', 75]] },

  // ── 饮料 ──────────────────────────────────────────────
  { id: 'cola', name: '可乐', category: 'drink', kcal: 43, protein: 0.0, fat: 0.0, carb: 10.0, servings: [['一罐', 330]] },
  { id: 'juice_orange', name: '橙汁（含糖）', category: 'drink', kcal: 45, protein: 0.7, fat: 0.2, carb: 9.0, servings: [['一杯', 250]] },
  { id: 'bubble_tea', name: '奶茶（全糖常规）', category: 'drink', kcal: 85, protein: 1.0, fat: 2.5, carb: 14.0, servings: [['中杯', 500]] },
  // 啤酒每 100ml 另有约 3.6ml 酒精（7 kcal/g），这部分热量不在碳蛋脂里
  { id: 'beer', alcohol: true, name: '啤酒', category: 'drink', kcal: 40, protein: 0.4, fat: 0.0, carb: 3.6, servings: [['一罐', 330]] },
  { id: 'black_coffee', name: '黑咖啡（无糖）', category: 'drink', kcal: 2, protein: 0.2, fat: 0, carb: 0.3, servings: [['一杯', 250]] },
  { id: 'latte', name: '拿铁（全脂奶）', category: 'drink', kcal: 55, protein: 3.0, fat: 3.0, carb: 4.5, servings: [['中杯', 350]] },
  { id: 'sports_drink', name: '运动饮料', category: 'drink', kcal: 26, protein: 0, fat: 0, carb: 6.5, servings: [['一瓶', 500]] },

  // ── 零食甜品 ──────────────────────────────────────────
  { id: 'chips', name: '薯片', category: 'snack', kcal: 536, protein: 6.0, fat: 34.0, carb: 49.4, servings: [['一小包', 50], ['一大包', 100]] },
  { id: 'chocolate', name: '巧克力（牛奶）', category: 'snack', kcal: 586, protein: 4.3, fat: 38.4, carb: 51.9, servings: [['一小块', 10], ['一排', 40]] },
  { id: 'cookie', name: '曲奇/饼干', category: 'snack', kcal: 435, protein: 5.0, fat: 12.7, carb: 72.5, servings: [['一块', 12]] },
  { id: 'cake_cream', name: '奶油蛋糕', category: 'snack', kcal: 379, protein: 4.5, fat: 13.0, carb: 59.0, servings: [['一块', 100]] },
  { id: 'icecream', name: '冰淇淋', category: 'snack', kcal: 207, protein: 3.5, fat: 11.0, carb: 23.5, servings: [['一个球', 60]] },
  { id: 'bread_white', name: '白吐司', category: 'snack', kcal: 312, protein: 8.3, fat: 5.1, carb: 58.6, servings: [['一片', 35]] },
  { id: 'bread_whole', name: '全麦面包', category: 'snack', kcal: 246, protein: 9.0, fat: 4.4, carb: 44.0, servings: [['一片', 40]] },
  { id: 'sugar', name: '白砂糖', category: 'snack', kcal: 400, protein: 0.0, fat: 0.0, carb: 99.9, servings: [['一勺', 8]] },
  { id: 'protein_bar', name: '蛋白棒', category: 'snack', kcal: 380, protein: 30.0, fat: 11.0, carb: 35.0, servings: [['一根', 40]] },

  // ── 家常菜（油量按普通做法估，误差最大，仅供参考）────────
  { id: 'stirfry_greens', name: '炒青菜（家常油量）', category: 'dish', kcal: 95, protein: 2.5, fat: 6.0, carb: 5.0, servings: [['一份', 200]] },
  { id: 'tomato_egg', name: '西红柿炒鸡蛋', category: 'dish', kcal: 110, protein: 6.0, fat: 7.5, carb: 5.0, servings: [['一份', 250]] },
  { id: 'gongbao', name: '宫保鸡丁', category: 'dish', kcal: 180, protein: 11.0, fat: 11.0, carb: 9.0, servings: [['一份', 200]] },
  { id: 'mapo_tofu', name: '麻婆豆腐', category: 'dish', kcal: 135, protein: 8.0, fat: 9.0, carb: 5.0, servings: [['一份', 250]] },
  { id: 'braised_pork', name: '红烧肉', category: 'dish', kcal: 380, protein: 10.0, fat: 29.5, carb: 7.0, servings: [['一份', 150]] },
  { id: 'hotpot_base', name: '火锅（清汤涮菜肉）', category: 'dish', kcal: 120, protein: 11.0, fat: 6.0, carb: 5.0, servings: [['一顿', 600]] },
  { id: 'hotpot_spicy', name: '火锅（红油锅底涮）', category: 'dish', kcal: 220, protein: 10.0, fat: 18.0, carb: 5.0, servings: [['一顿', 600]] },
  { id: 'fried_rice', name: '蛋炒饭', category: 'dish', kcal: 163, protein: 4.5, fat: 5.5, carb: 23.0, servings: [['一份', 350]] },
  { id: 'beef_noodle', name: '牛肉面', category: 'dish', kcal: 105, protein: 5.5, fat: 3.5, carb: 13.5, servings: [['一碗', 600]] },
  { id: 'malatang', name: '麻辣烫（不喝汤）', category: 'dish', kcal: 130, protein: 7.0, fat: 8.0, carb: 8.0, servings: [['一份', 500]] },
  { id: 'salad_dressing', name: '沙拉酱（蛋黄酱类）', category: 'dish', kcal: 680, protein: 1.0, fat: 75.0, carb: 2.2, servings: [['一勺', 15]] },
  { id: 'chicken_salad', name: '鸡胸沙拉（少酱）', category: 'dish', kcal: 90, protein: 9.0, fat: 4.0, carb: 5.0, servings: [['一份', 300]] },
  // ── 常见中式小吃/街边食物（2026-10-20 补）──
  // 起因：用户说「半碗炒河粉加了三个小肉丸两串骨肉相连」，AI 认出来了但本地库里没有，
  // 结果一条都记不上。这些都是中国人日常真的会吃的，缺了会直接影响记录准确度。
  { id: 'fried_rice_noodle', name: '炒河粉（干炒）', category: 'dish', kcal: 190, protein: 6.5, fat: 8.0, carb: 24.0, servings: [['一份', 400], ['半份', 200]] },
  { id: 'fried_noodle', name: '炒面', category: 'dish', kcal: 175, protein: 6.0, fat: 7.5, carb: 22.0, servings: [['一份', 400], ['半份', 200]] },
  { id: 'fried_rice_dish', name: '炒饭（外卖）', category: 'dish', kcal: 165, protein: 5.5, fat: 6.5, carb: 22.0, servings: [['一份', 400], ['半份', 200]] },
  { id: 'meatball_pork', name: '猪肉丸', category: 'protein', kcal: 220, protein: 12.0, fat: 15.0, carb: 8.0, servings: [['一个', 20], ['一串', 100]] },
  { id: 'meatball_beef', name: '牛肉丸', category: 'protein', kcal: 170, protein: 17.0, fat: 8.0, carb: 6.0, servings: [['一个', 20], ['一串', 100]] },
  { id: 'grilled_skewer', name: '骨肉相连（烤串）', category: 'dish', kcal: 235, protein: 15.0, fat: 17.0, carb: 5.0, servings: [['一串', 40]] },
  { id: 'lamb_skewer', name: '羊肉串', category: 'dish', kcal: 250, protein: 18.0, fat: 19.0, carb: 1.0, servings: [['一串', 35]] },
  { id: 'sausage_grilled', name: '烤肠', category: 'protein', kcal: 290, protein: 12.0, fat: 24.0, carb: 6.0, servings: [['一根', 70]] },
  { id: 'hamburger', name: '汉堡', category: 'dish', kcal: 250, protein: 12.0, fat: 11.0, carb: 26.0, servings: [['一个', 200]] },
  { id: 'fried_chicken_leg', name: '炸鸡腿', category: 'dish', kcal: 280, protein: 18.0, fat: 18.0, carb: 11.0, servings: [['一个', 120]] },
  { id: 'luosifen', name: '螺蛳粉', category: 'dish', kcal: 115, protein: 5.0, fat: 4.5, carb: 14.0, servings: [['一碗', 600]] },
  { id: 'hot_sour_noodle', name: '酸辣粉', category: 'dish', kcal: 125, protein: 3.5, fat: 5.0, carb: 17.0, servings: [['一碗', 500]] },
  { id: 'liangpi', name: '凉皮', category: 'dish', kcal: 120, protein: 3.0, fat: 4.0, carb: 18.0, servings: [['一份', 300]] },
  { id: 'hand_pancake', name: '手抓饼', category: 'dish', kcal: 330, protein: 6.0, fat: 20.0, carb: 31.0, servings: [['一个', 120]] },
  { id: 'jianbing', name: '煎饼果子', category: 'dish', kcal: 250, protein: 8.5, fat: 12.0, carb: 28.0, servings: [['一个', 250]] },
  { id: 'oden', name: '关东煮', category: 'dish', kcal: 90, protein: 6.0, fat: 4.0, carb: 7.0, servings: [['一串', 40]] },

  // ── v31：用户真正常吃、但库里没有的（缺了它们，AI 听懂了也记不上）──
  // 数据口径：每 100 克可食部，家常做法；4/9/4 折算由 checkFoodData 自检。
  // 目的不是精确到个位数，而是「先能记上、量级不能差一倍」。
  { id: 'suancaiyu', name: '酸菜鱼', category: 'dish', kcal: 110, protein: 10.0, fat: 6.5, carb: 3.5, servings: [['一份', 500]] },
  { id: 'shuizhuyu', name: '水煮鱼', category: 'dish', kcal: 155, protein: 11.0, fat: 11.0, carb: 3.0, servings: [['一份', 500]] },
  { id: 'roujiamo', name: '肉夹馍', category: 'dish', kcal: 290, protein: 11.0, fat: 12.0, carb: 34.0, servings: [['一个', 150]] },
  { id: 'sushi', name: '寿司', category: 'dish', kcal: 150, protein: 6.0, fat: 2.5, carb: 25.0, servings: [['一贯', 25], ['一份（8 贯）', 200]] },
  { id: 'onigiri', name: '饭团', category: 'dish', kcal: 180, protein: 5.0, fat: 4.0, carb: 31.0, servings: [['一个', 120]] },
  { id: 'kaolengmian', name: '烤冷面', category: 'dish', kcal: 210, protein: 7.0, fat: 8.0, carb: 27.0, servings: [['一份', 250]] },
  { id: 'jidanbing', name: '鸡蛋灌饼', category: 'dish', kcal: 240, protein: 8.0, fat: 12.0, carb: 26.0, servings: [['一个', 200]] },
  { id: 'xiaolongbao', name: '小笼包', category: 'dish', kcal: 230, protein: 9.0, fat: 9.0, carb: 28.0, servings: [['一个', 25], ['一笼（8 个）', 200]] },
  { id: 'shengjianbao', name: '生煎包', category: 'dish', kcal: 260, protein: 9.0, fat: 12.0, carb: 29.0, servings: [['一个', 45]] },
  { id: 'shaomai', name: '烧麦', category: 'dish', kcal: 230, protein: 8.0, fat: 9.0, carb: 29.0, servings: [['一个', 30]] },
  { id: 'youtiao', name: '油条', category: 'staple', kcal: 388, protein: 7.0, fat: 18.0, carb: 50.0, servings: [['一根', 70]] },
  { id: 'congyoubing', name: '葱油饼', category: 'staple', kcal: 330, protein: 6.0, fat: 17.0, carb: 39.0, servings: [['一个', 120]] },
  { id: 'luroufan', name: '卤肉饭', category: 'dish', kcal: 180, protein: 7.0, fat: 7.0, carb: 22.0, servings: [['一份', 450]] },
  { id: 'zhujiaofan', name: '猪脚饭', category: 'dish', kcal: 200, protein: 9.0, fat: 10.0, carb: 19.0, servings: [['一份', 500]] },
  { id: 'galifan', name: '咖喱鸡饭', category: 'dish', kcal: 160, protein: 6.0, fat: 6.0, carb: 20.0, servings: [['一份', 450]] },
  { id: 'jigongbao', name: '鸡公煲', category: 'dish', kcal: 150, protein: 10.0, fat: 9.0, carb: 7.0, servings: [['一份', 500]] },
  { id: 'pisa', name: '披萨', category: 'dish', kcal: 260, protein: 11.0, fat: 10.0, carb: 31.0, servings: [['一块', 100], ['一整个（6 块）', 600]] },
  { id: 'doufunao', name: '豆腐脑', category: 'dish', kcal: 50, protein: 3.0, fat: 2.5, carb: 4.0, servings: [['一碗', 300]] },
  { id: 'pidan_zhou', name: '皮蛋瘦肉粥', category: 'dish', kcal: 60, protein: 3.5, fat: 1.5, carb: 8.0, servings: [['一碗', 350]] },
  { id: 'zongzi', name: '粽子', category: 'staple', kcal: 200, protein: 5.0, fat: 7.0, carb: 30.0, servings: [['一个', 150]] },
  { id: 'tangyuan', name: '汤圆', category: 'snack', kcal: 300, protein: 5.0, fat: 12.0, carb: 42.0, servings: [['一个', 20], ['一碗（8 个）', 160]] },
  { id: 'yuebing', name: '月饼', category: 'snack', kcal: 400, protein: 6.0, fat: 20.0, carb: 50.0, servings: [['一个', 100]] },
  { id: 'fries', name: '薯条', category: 'dish', kcal: 312, protein: 3.5, fat: 15.0, carb: 41.0, servings: [['小份', 75], ['中份', 110], ['大份', 150]] },
  { id: 'jipai', name: '鸡排', category: 'dish', kcal: 280, protein: 18.0, fat: 17.0, carb: 14.0, servings: [['一块', 150]] },
  { id: 'jianjiao', name: '煎饺 / 锅贴', category: 'dish', kcal: 250, protein: 8.0, fat: 12.0, carb: 27.0, servings: [['一个', 25], ['一份（8 个）', 200]] },
  { id: 'mala_xiangguo', name: '麻辣香锅', category: 'dish', kcal: 180, protein: 8.0, fat: 12.0, carb: 10.0, servings: [['一份', 500]] },
  { id: 'liangmian', name: '凉面', category: 'dish', kcal: 150, protein: 4.5, fat: 5.0, carb: 22.0, servings: [['一份', 400]] },
  { id: 'qingjiao_rousi', name: '青椒肉丝', category: 'dish', kcal: 120, protein: 7.0, fat: 8.0, carb: 5.0, servings: [['一份', 250]] },
  { id: 'yuxiang_rousi', name: '鱼香肉丝', category: 'dish', kcal: 150, protein: 7.0, fat: 10.0, carb: 7.0, servings: [['一份', 250]] },
  { id: 'huiguorou', name: '回锅肉', category: 'dish', kcal: 300, protein: 9.0, fat: 27.0, carb: 6.0, servings: [['一份', 200]] },
  { id: 'tudousi', name: '炒土豆丝', category: 'dish', kcal: 120, protein: 2.0, fat: 6.0, carb: 15.0, servings: [['一份', 200]] },
  { id: 'mixed_nuts', name: '混合坚果', category: 'fat', kcal: 600, protein: 18.0, fat: 50.0, carb: 20.0, servings: [['一小把', 25], ['一包（每日坚果）', 25]] },
];


/** 除名称外还支持这些俗称搜索 */
export const ALIASES = {
  rice_cooked: ['白米饭', '米饭', '米'],
  rice_raw: ['米', '生米'],
  congee: ['稀饭', '粥'],
  bun: ['馍', '花卷'],
  baozi_pork: ['包子', '肉包', '大包子'],
  noodle_cooked: ['面', '汤面', '捞面'],
  noodle_raw: ['面', '面条'],
  // 注意：别名里不要放「水煮鸡胸」「煎鸡胸」这种带做法词的 —— 解析时会把做法词一起吞掉，
  // 导致「水煮」这种用油量提示失效（v30 踩过）。带做法的说法靠名字包含匹配 + 做法词识别。
  chicken_breast_cooked: ['鸡胸肉', '鸡胸', '鸡脯肉', '鸡肉', '熟鸡胸'],
  chicken_breast: ['生鸡胸', '生鸡胸肉', '生鸡脯肉', '生重鸡胸'],
  chicken_thigh_cooked: ['鸡腿', '鸡腿肉', '鸡肉', '卤鸡腿', '烤鸡腿'],
  chicken_thigh: ['生鸡腿', '生鸡腿肉'],
  pork_lean_cooked: ['猪瘦肉', '瘦猪肉', '猪肉', '瘦肉', '里脊'],
  pork_lean: ['生猪瘦肉', '生猪瘦肉', '生瘦肉', '生猪肉'],
  beef_lean_cooked: ['瘦牛肉', '牛肉', '牛排', '牛柳'],
  beef_lean: ['生牛肉', '生瘦牛肉', '生牛排'],
  egg: ['白煮蛋', '水煮蛋', '煎蛋', '荷包蛋', '蛋'],
  milk_whole: ['牛奶', '纯牛奶'],
  milk_skim: ['低脂奶', '脱脂奶'],
  yogurt_plain: ['酸奶'],
  oil: ['油', '菜籽油', '橄榄油', '花生油', '色拉油'],
  bubble_tea: ['奶茶', '波霸', '珍珠奶茶'],
  black_coffee: ['美式', '咖啡'],
  stirfry_greens: ['炒菜', '青菜', '时蔬'],
  chicken_salad: ['沙拉', '轻食'],
  fried_rice_noodle: ['炒河粉', '河粉', '炒粉', '干炒牛河', '炒米粉', '炒粿条'],
  fried_noodle: ['炒面', '酱油炒面', '炒面条'],
  fried_rice_dish: ['炒饭', '扬州炒饭', '外卖炒饭'],
  meatball_pork: ['肉丸', '肉圆', '小肉丸', '猪肉丸子', '丸子'],
  meatball_beef: ['牛肉丸', '撒尿牛丸', '牛肉丸子'],
  grilled_skewer: ['骨肉相连', '烤串', '肉串', '烤骨肉相连'],
  lamb_skewer: ['羊肉串', '烤羊肉串'],
  sausage_grilled: ['烤肠', '热狗肠', '台湾烤肠'],
  hamburger: ['汉堡', '汉堡包', '鸡肉堡', '牛肉堡'],
  fried_chicken_leg: ['炸鸡腿', '炸鸡'],
  luosifen: ['螺蛳粉', '螺丝粉'],
  hot_sour_noodle: ['酸辣粉'],
  liangpi: ['凉皮', '擀面皮'],
  hand_pancake: ['手抓饼', '千层饼'],
  jianbing: ['煎饼果子', '煎饼'],
  oden: ['关东煮'],
  sweet_potato: ['地瓜', '番薯'],
  potato: ['马铃薯', '土豆'],
  corn: ['苞米', '棒子'],
  oats: ['燕麦'],
  tofu_firm: ['豆腐'],
  shrimp_cooked: ['虾', '虾仁', '大虾', '基围虾', '熟虾'],
  shrimp: ['生虾', '生虾仁', '鲜虾'],
  salmon_cooked: ['三文鱼', '鲑鱼', '熟三文鱼'],
  salmon: ['生三文鱼', '生鲑鱼'],
  white_fish_cooked: ['龙利鱼', '巴沙鱼', '鱼片', '熟鱼片', '清蒸龙利鱼'],
  white_fish: ['生龙利鱼', '生巴沙鱼'],
  seaweed: ['海带丝'],
  mushroom: ['冬菇', '菌菇'],
  cola: ['汽水', '可乐'],
  chips: ['薯片'],
  bread_whole: ['全麦吐司'],
  // v31 补的别名：都是用户口语里真会说的词，之前缺了它们，
  // AI 明明听懂了、本地库也有这条，却匹配不上（v31 的核心修复之一）。
  cake_cream: ['蛋糕', '奶油蛋糕'],
  sugar: ['糖', '白糖', '砂糖'],
  soy_milk: ['豆浆', '无糖豆奶'],
  almond: ['杏仁', '巴旦木', '扁桃仁'],
  bread_white: ['吐司', '切片面包', '白面包'],
  tomato_egg: ['番茄炒蛋', '西红柿炒蛋', '西红柿鸡蛋', '番茄鸡蛋'],
  gongbao: ['宫爆鸡丁', '宫保鸡丁', '宫爆鸡'],
  braised_pork: ['红烧五花肉', '红烧肉'],
  mapo_tofu: ['麻婆豆腐'],
  fried_rice: ['蛋炒饭', '炒米饭'],
  chicken_skin: ['炸鸡', '炸鸡块', '炸鸡带皮'],
  stirfry_greens: ['炒青菜', '炒菜', '青菜', '时蔬', '清炒时蔬'],
  beef_noodle: ['牛肉面', '牛肉拉面', '拉面'],
  hamburger: ['汉堡', '汉堡包', '鸡肉堡', '牛肉堡'],
  // 新条目
  suancaiyu: ['酸菜鱼', '老坛酸菜鱼', '酸菜鱼片'],
  shuizhuyu: ['水煮鱼', '水煮鱼片'],
  roujiamo: ['肉夹馍', '腊汁肉夹馍'],
  sushi: ['寿司', '寿司拼盘'],
  onigiri: ['饭团', '三角饭团', '紫菜包饭'],
  kaolengmian: ['烤冷面', '东北烤冷面'],
  jidanbing: ['鸡蛋灌饼', '灌饼'],
  xiaolongbao: ['小笼包', '灌汤包', '小笼'],
  shengjianbao: ['生煎', '生煎包'],
  shaomai: ['烧麦', '烧卖'],
  youtiao: ['油条'],
  congyoubing: ['葱油饼'],
  luroufan: ['卤肉饭', '台湾卤肉饭'],
  zhujiaofan: ['猪脚饭', '猪手饭'],
  galifan: ['咖喱鸡饭', '咖喱饭', '咖喱鸡'],
  jigongbao: ['鸡公煲'],
  pisa: ['披萨', '比萨', '匹萨'],
  doufunao: ['豆腐脑', '豆花'],
  pidan_zhou: ['皮蛋瘦肉粥', '皮蛋粥', '瘦肉粥'],
  zongzi: ['粽子', '肉粽'],
  tangyuan: ['汤圆', '元宵'],
  yuebing: ['月饼'],
  fries: ['薯条', '炸薯条'],
  jipai: ['鸡排', '炸鸡排'],
  jianjiao: ['煎饺', '锅贴', '煎饺子'],
  mala_xiangguo: ['麻辣香锅', '香锅'],
  liangmian: ['凉面', '麻酱凉面'],
  qingjiao_rousi: ['青椒肉丝', '尖椒肉丝'],
  yuxiang_rousi: ['鱼香肉丝'],
  huiguorou: ['回锅肉'],
  tudousi: ['炒土豆丝', '土豆丝'],
  mixed_nuts: ['坚果', '混合坚果', '每日坚果', '一把坚果'],
};

/**
 * 「按同类估算」用的兜底表。
 *
 * 用途：AI 或离线听懂了这句话，但本地库里确实没有这样东西（比如某个地方小吃、家里自制的菜）。
 * 以前的做法是「一条都不记 + 告诉用户库里没有」，用户要么放弃记录、要么得自己搜——两样都很伤积极性。
 * 现在按「它大概属于哪一类」给一个同类均值先记上，并且**在界面上写明这是估算、可以删掉**。
 *
 * 这不是放开「AI 编热量」的口子：这些数字是本地写死的同类均值，可核对、可离线复算，
 * 模型依然一个营养数字都不许输出。
 */
export const GENERIC_ESTIMATES = [
  // 顺序很重要：先主食（「皮蛋瘦肉粥」别被「肉」抢走），再肉、汤、甜点、饮料、零食、水果、蔬菜
  { id: 'generic_staple', name: '主食（按同类估算）', category: 'staple', kcal: 180, protein: 5.0, fat: 3.0, carb: 32.0, servings: [['一份', 300]], keywords: /饭|面|粉|饼|包|馍|饺|馄饨|粥|馒头|花卷|油条|年糕|米糕|粽|麦|吐司|披萨|寿司|饭团|汉堡|卷/ },
  { id: 'generic_meat', name: '肉菜（按同类估算）', category: 'dish', kcal: 220, protein: 15.0, fat: 16.0, carb: 4.0, servings: [['一份', 200]], keywords: /肉|鸡|鸭|鹅|牛|羊|猪|排|鱼|虾|蟹|海鲜|丸|肠|培根|火腿|翅|肘/ },
  { id: 'generic_soup', name: '汤羹（按同类估算）', category: 'dish', kcal: 60, protein: 3.0, fat: 3.0, carb: 5.0, servings: [['一碗', 400]], keywords: /汤|羹|煲/ },
  { id: 'generic_dessert', name: '甜点（按同类估算）', category: 'snack', kcal: 280, protein: 3.0, fat: 12.0, carb: 40.0, servings: [['一份', 150]], keywords: /蛋糕|甜|糖|巧克力|冰淇淋|冰激凌|派|挞|布丁|奶昔|沙冰|奶油|提拉米苏|慕斯/ },
  { id: 'generic_drink', name: '饮料（按同类估算）', category: 'drink', kcal: 45, protein: 1.0, fat: 1.0, carb: 9.0, servings: [['一杯', 400]], keywords: /茶|咖啡|汁|可乐|汽水|酒|奶昔|豆浆|奶盖|椰子水|苏打水|矿泉水|气泡水/ },
  { id: 'generic_snack', name: '零食（按同类估算）', category: 'snack', kcal: 450, protein: 6.0, fat: 22.0, carb: 55.0, servings: [['一小包', 50]], keywords: /薯|片|坚果|辣条|饼干|果干|牛肉干/ },
  { id: 'generic_fruit', name: '水果（按同类估算）', category: 'fruit', kcal: 60, protein: 0.8, fat: 0.3, carb: 14.0, servings: [['一个', 200]], keywords: /果|瓜|莓|蕉|橙|桔|橘|柚|桃|梨|葡萄|荔|芒|菠萝|枣/ },
  { id: 'generic_veg', name: '蔬菜（按同类估算）', category: 'vegetable', kcal: 70, protein: 2.5, fat: 4.0, carb: 6.0, servings: [['一份', 200]], keywords: /菜|豆|菇|笋|瓜|茄|椒|萝卜|藕|菌/ },
  { id: 'generic_dish', name: '家常菜（按同类估算）', category: 'dish', kcal: 150, protein: 7.0, fat: 9.0, carb: 8.0, servings: [['一份', 250]], keywords: null },
];

/**
 * 名字完全没见过时，按关键词归到「哪一类」，返回同类均值条目。
 * 顺序有讲究：先判肉/主食，再判汤/甜点/饮料/水果/蔬菜/零食，最后落到「家常菜」。
 */
export function genericEstimateFor(name) {
  const q = String(name || '');
  for (const g of GENERIC_ESTIMATES) {
    if (g.keywords && g.keywords.test(q)) return g;
  }
  return GENERIC_ESTIMATES[GENERIC_ESTIMATES.length - 1];
}

const ROUNDING_TOLERANCE = 0.22; // 食物表的热量普遍按 4/9/4 折算，允许 22% 偏差

/** 数据自检：热量和三大营养素必须大致对得上，否则说明填错了 */
export function checkFoodData(foods = FOODS) {
  const problems = [];
  const ids = new Set();
  for (const f of foods) {
    if (!f.id || !f.name) problems.push(`缺少 id 或名称: ${JSON.stringify(f)}`);
    if (ids.has(f.id)) problems.push(`id 重复: ${f.id}`);
    ids.add(f.id);
    for (const k of ['kcal', 'protein', 'fat', 'carb']) {
      if (typeof f[k] !== 'number' || !Number.isFinite(f[k]) || f[k] < 0) {
        problems.push(`${f.name} 的 ${k} 不合法: ${f[k]}`);
      }
    }
    if (!FOOD_CATEGORIES.some((c) => c.key === f.category)) {
      problems.push(`${f.name} 的分类不存在: ${f.category}`);
    }
    if (!Array.isArray(f.servings) || f.servings.length === 0) {
      problems.push(`${f.name} 没给常见份量`);
    } else {
      for (const s of f.servings) {
        if (!Array.isArray(s) || typeof s[0] !== 'string' || !(s[1] > 0)) {
          problems.push(`${f.name} 的份量不合法: ${JSON.stringify(s)}`);
        }
      }
    }
    // 啤酒这类含酒精的饮品，酒精热量（7 kcal/g）不在碳蛋脂里，折算必然对不上，跳过
    const macros = f.protein * 4 + f.fat * 9 + f.carb * 4;
    if (f.kcal > 20 && macros > 0 && !f.alcohol) {
      const drift = Math.abs(macros - f.kcal) / f.kcal;
      if (drift > ROUNDING_TOLERANCE) {
        problems.push(`${f.name} 热量(${f.kcal}) 与碳蛋脂折算(${round1(macros)}) 差 ${Math.round(drift * 100)}%，请核对`);
      }
    }
    if (f.kcal > 950) problems.push(`${f.name} 每 100 克热量 ${f.kcal}，超过纯油(899)，几乎肯定填错`);
  }
  return problems;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

export function findFood(id) {
  return FOODS.find((f) => f.id === id) || null;
}

/** 按 id 找「可匹配食物」（含组合菜换算出来的那份，AI 返回组合菜 id 时要用） */
export function findMatchableFood(id) {
  return CATALOG_FOODS.find((f) => f.id === id) || null;
}

/**
 * 从一句话里判断「生重还是熟重」。
 *
 * 为什么重要：100 克生鸡胸 118 kcal，做熟后 100 克约 157 kcal —— 同样说「100 克鸡胸肉」，
 * 按生重算会少近 25%。普通人称/估份量时基本都是**做熟之后的重量**，所以：
 *  - 说了「生 / 生重」→ 生重；
 *  - 说了做法（水煮/煎/炒/烤/蒸/卤/红烧/熟重…）→ 熟重；
 *  - 什么都没说 → 默认熟重（下面匹配时 default 就是 cooked）。
 */
export function detectFoodForm(text) {
  const s = String(text || '');
  if (/生重|生(?:的)?(?:[\u4e00-\u9fa5]{0,2})(鸡|鸡脯|鸡腿|牛|猪|羊|鱼|虾|肉)/.test(s)) return 'raw';
  if (/熟重|熟(的)?(鸡|牛|猪|鱼|虾|肉)|水煮|白灼|清蒸|煎|烤|炒|卤|炖|红烧|空气炸|蒸熟|煮熟/.test(s)) return 'cooked';
  return null;
}

/** 组合菜按「每 100 克」换算出来的可匹配条目（AI 说「黄焖鸡米饭」「馄饨」时要靠它） */
export const DISH_FOODS = DISHES.map(dishAsFood).filter(
  // 和食材表重复的 id 以食材表为准（食材表更细：牛肉面在两边都有）
  (d) => !FOODS.some((f) => f.id === d.id),
);

/** 匹配和搜索用：食材 + 组合菜。顺序上食材优先，避免组合菜抢走更具体的条目 */
export const CATALOG_FOODS = [...FOODS, ...DISH_FOODS];

/** 这条食物有哪些别名（组合菜的别名在 dishes.js 里，不重复维护一份） */
export function aliasesOf(food) {
  return food?._aliases || ALIASES[food.id] || [];
}

const aliasList = aliasesOf;

/** 名称归一化：去掉括号补充、空格、标点，方便比较 */
function normName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')   // 「米饭（熟）」→「米饭」：括号里是生熟说明，不该影响匹配
    .replace(/[\s·・,，。.、!！?？/\-]/g, '');
}

/**
 * 按「名字」找本地食物。
 *
 * 为什么要单独做这个：AI 返回的是名字，没有数据库 id。以前这里要求 AI 提供 id 或热量，
 * 但提示词又禁止 AI 输出热量 —— 结果**每一条都被丢掉**，AI 模式等于没工作。
 * v34 起 AI 会给营养估算，但**本地命中仍然优先**：常见食物用库里的固定数字更稳；
 * 「我的食物」（customFoods）也参与匹配，使用者自己存过的优先级最高。
 *
 * 返回 `{food, score, reason, custom}` 或 null。宁可返回 null，也不要给一个错的食物：
 * 匹配错了比没匹配上更糟（用户看到"炒河粉 116 kcal"会以为准，其实差了一倍）。
 *
 * 生熟口径：默认找「熟重」那条（见 detectFoodForm）；同一个食物有生/熟两条时，
 * 名字里带「生…」或句子里说「生重」才会落到生重那条。
 *
 * @param {string} name
 * @param {{ minScore?: number, preferForm?: 'raw'|'cooked'|null }} options
 */
export function matchFoodByName(name, { minScore = 70, preferForm = null, customFoods = [] } = {}) {
  const q = normName(name);
  if (!q) return null;
  const wantForm = preferForm || detectFoodForm(name) || 'cooked';

  let best = null;
  const consider = (food, score, reason, custom = false) => {
    // 生熟两条都匹配上时，按「想要的那条」加减 8 分来决定（不是按数组顺序，测试可抓）
    const formBonus = food.form ? (food.form === wantForm ? 8 : -8) : 0;
    // 「我的食物」优先：同名时用使用者自己存的那条，而不是库里一条名字相近的。
    // +12 要大于生熟 +8，否则「鸡胸肉」这种熟重条目会把同名的自定义食物压过去。
    const total = score + formBonus + (custom ? 12 : 0);
    if (!best || total > best.score) best = { food, score: total, reason, custom };
  };

  // 先看「我的食物」，再看固定食物库：使用者自己存过的优先级最高（v34）
  const pool = [
    ...customFoods.filter((f) => f && f.id && f.name).map((f) => ({ food: f, custom: true })),
    ...CATALOG_FOODS.map((f) => ({ food: f, custom: false })),
  ];

  for (const { food, custom } of pool) {
    const n = normName(food.name);
    // 1) 名字完全一致（去掉括号说明后）
    if (n === q) { consider(food, 100, '名字一致', custom); continue; }
    // 2) 别名完全一致
    const aliases = aliasList(food);
    let aliasHit = null;
    for (const a of aliases) {
      if (normName(a) === q) { aliasHit = a; break; }
    }
    if (aliasHit) { consider(food, 95, `别名「${aliasHit}」`, custom); continue; }
    // 3) 一方包含另一方，且重叠部分够长（避免「河粉」匹配到「粉蒸肉」这种）
    const short = n.length <= q.length ? n : q;
    const long = n.length <= q.length ? q : n;
    if (short.length >= 2 && long.includes(short) && short.length / long.length >= 0.5) {
      consider(food, 70 + Math.round((short.length / long.length) * 20), '名字包含', custom);
      continue;
    }
    // 4) 别名包含：AI 说「炒河粉」，库里「米粉/河粉（熟）」的别名有「河粉」
    for (const a of aliases) {
      const na = normName(a);
      if (na.length < 2) continue;
      if (q.includes(na) && na.length / q.length >= 0.5) {
        consider(food, 65 + Math.round((na.length / q.length) * 15), `别名包含「${a}」`, custom);
      }
    }
  }

  if (!best || best.score < minScore) return null;
  return best;
}

/**
 * 「只填热量」用的合成食物。
 *
 * 场景：在外面吃、没包装、也懒得描述 —— 用户只知道「这一顿大概 650 大卡」。
 * 以前只能去食物库里找个相近的条目，找不准反而更糟，所以给用户一条直路。
 *
 * 做法：把它当成「每 100 克 = 这一顿」的食物，克数固定 100 ——
 * 记录、汇总、删除、导出全都沿用现有结构，不需要新类型。
 * 标记 kcalOnly，界面上就不显示「100 克」（用户从没填过克数）。
 *
 * @returns {{ok:true, food:object}|{ok:false, error:string}}
 */
export function kcalOnlyFood({ name, kcal, protein } = {}) {
  const k = Number(kcal);
  if (!Number.isFinite(k) || k <= 0) return { ok: false, error: '热量要填一个大于 0 的数字（kcal）。' };
  if (k > 5000) return { ok: false, error: '一次超过 5000 kcal，确认一下是不是多填了一位。' };
  const rawP = protein === '' || protein === null || protein === undefined ? 0 : Number(protein);
  if (!Number.isFinite(rawP) || rawP < 0) return { ok: false, error: '蛋白要填一个数字（克），不填就按 0 算。' };
  if (rawP > 300) return { ok: false, error: '蛋白超过 300 克不太可能，确认一下单位。' };
  if (rawP * 4 > k) return { ok: false, error: `光蛋白 ${rawP} 克就有 ${Math.round(rawP * 4)} kcal，超过总热量了，核对一下。` };
  const label = String(name || '').trim() || '只记了热量';
  return {
    ok: true,
    food: {
      id: 'kcal_only',
      name: label,
      kcal: Math.round(k),
      protein: Math.round(rawP * 10) / 10,
      fat: 0,
      carb: 0,
      category: 'custom',
      // 界面据此显示「按热量记」而不是「100 克」
      kcalOnly: true,
      servings: [['这一顿', 100]],
    },
  };
}

/**
 * 把各种写法统一成克数。
 * 支持：150克 / 150g / 200毫升 / 0.5斤 / 一两 / 一小碗 / 半个 / 两个 / 3个 / 直接写数字
 * 看不懂的返回 null —— 宁可让用户重填，也不要猜一个数出来。
 */
export function parseAmount(text, food = null) {
  if (text === null || text === undefined) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const s = raw.replace(/[，,]/g, '').replace(/\s+/g, '');

  const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let qty = null;
  let unit = '';

  const numMatch = s.match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (numMatch) {
    qty = Number(numMatch[1]);
    unit = numMatch[2];
  } else if (/^(半)/.test(s)) {
    qty = 0.5;
    unit = s.slice(1);
  } else if (CN_NUM[s[0]]) {
    qty = CN_NUM[s[0]];
    unit = s.slice(1);
  } else {
    return null; // 没有数字也没有量词，看不懂
  }
  if (!(qty > 0)) return null;

  // 单位换算
  if (/斤/.test(unit)) return round1(qty * 500);
  if (/两/.test(unit)) return round1(qty * 50);
  if (/毫升|ml|ML|毫昇/.test(unit)) return round1(qty); // 奶、饮料按 1ml≈1g 处理
  if (/克|g|G/.test(unit)) return round1(qty);
  if (!unit) return round1(qty); // 只写了数字，按克算

  // 按食物的常见份量换算（「一碗」「两个」）
  if (food && Array.isArray(food.servings)) {
    const clean = (x) => String(x).replace(/^一/, '').replace(/[（(].*?[)）]/g, '');
    const pairs = food.servings
      .map(([label, grams]) => ({ key: clean(label), grams }))
      .filter((x) => x.key);
    // 先精确匹配：否则「一碗」会被表里排在前面的「一小碗」抢走，少算近三成
    const exact = pairs.find((x) => x.key === unit);
    if (exact) return round1(qty * exact.grams);
    // 再退到包含匹配，并且取最长的那个 key（「一大碗」优先于「碗」）
    const loose = pairs
      .filter((x) => x.key.includes(unit) || unit.includes(x.key))
      .sort((a, b) => b.key.length - a.key.length)[0];
    if (loose) return round1(qty * loose.grams);
  }
  return null;
}
