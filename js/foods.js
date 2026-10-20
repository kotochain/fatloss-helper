/**
 * 常见食物营养数据（每 100 克可食部）
 *
 * 数据来源与准确度说明（重要，别当成精确值用）：
 *  - 大部分条目参考《中国食物成分表（第 6 版）》，少部分按更贴近实际吃到的口径：
 *    全脂牛奶按中国市售包装标签（65 kcal/100ml，比成分表的 54 更接近日常喝的）；
 *    鸡胸肉、红薯、西兰花、三文鱼按 USDA FoodData Central（更接近去皮去骨/养殖的实际值）。
 *    两张表的口径差异可达 ±20%，所以本表只当估算。
 *  - 生熟状态差别很大，本表对主食明确区分「生」和「熟」（米饭、面条按熟重计）。
 *  - 品牌、做法、放油量都会让真实值上下浮动 10%~30%，尤其是炒菜和外卖。
 *  - 包装食品请直接照包装背面的「每 100 克」抄进「自定义食物」，那才是准的。
 *  - 自检规则：蛋白×4 + 脂肪×9 + 碳水×4 应当接近标称热量（含酒精的饮品除外）。
 */

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
  { id: 'chicken_breast', name: '鸡胸肉（去皮生）', category: 'protein', kcal: 118, protein: 24.0, fat: 1.9, carb: 0.6, servings: [['一块', 150]] },
  { id: 'chicken_thigh', name: '鸡腿肉（去皮）', category: 'protein', kcal: 145, protein: 19.0, fat: 7.0, carb: 0, servings: [['一个', 100]] },
  { id: 'chicken_wing', name: '鸡翅', category: 'protein', kcal: 194, protein: 17.4, fat: 11.8, carb: 4.6, servings: [['一个', 50]] },
  { id: 'chicken_skin', name: '炸鸡（带皮）', category: 'dish', kcal: 279, protein: 20.0, fat: 17.0, carb: 10.0, servings: [['一块', 100]] },
  { id: 'pork_lean', name: '猪瘦肉（生）', category: 'protein', kcal: 143, protein: 20.3, fat: 6.2, carb: 1.5, servings: [['一小份', 100]] },
  { id: 'pork_belly', name: '五花肉（生）', category: 'protein', kcal: 508, protein: 9.0, fat: 53.0, carb: 0, servings: [['一小份', 80]] },
  { id: 'pork_rib', name: '排骨（生）', category: 'protein', kcal: 278, protein: 18.0, fat: 23.0, carb: 1.0, servings: [['一根', 80]] },
  { id: 'beef_lean', name: '牛里脊/瘦牛肉（生）', category: 'protein', kcal: 125, protein: 20.2, fat: 4.2, carb: 1.2, servings: [['一小份', 120]] },
  { id: 'beef_fatty', name: '肥牛/雪花牛肉', category: 'protein', kcal: 300, protein: 16.0, fat: 26.0, carb: 0, servings: [['一份', 100]] },
  { id: 'lamb', name: '羊肉（瘦）', category: 'protein', kcal: 118, protein: 20.5, fat: 3.9, carb: 0.2, servings: [['一份', 100]] },
  { id: 'shrimp', name: '虾（鲜）', category: 'protein', kcal: 93, protein: 18.6, fat: 0.8, carb: 2.8, servings: [['一只', 15], ['10 只', 150]] },
  // 按养殖大西洋鲑（USDA FoodData Central 175167）：208/20.4/13.4。
  // 之前误用了《中国食物成分表》「鲑鱼（大马哈鱼）」的 139/17.2/7.8（野生太平洋鲑），每 100 克少算约 70 kcal
  { id: 'salmon', name: '三文鱼（养殖生）', category: 'protein', kcal: 208, protein: 20.4, fat: 13.4, carb: 0.0, servings: [['一份', 120]] },
  { id: 'salmon_wild', name: '大马哈鱼（野生）', category: 'protein', kcal: 139, protein: 17.2, fat: 7.8, carb: 0.0, servings: [['一份', 120]] },
  { id: 'white_fish', name: '巴沙鱼/龙利鱼', category: 'protein', kcal: 90, protein: 17.0, fat: 2.0, carb: 0, servings: [['一份', 150]] },
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
  chicken_breast: ['鸡胸', '鸡脯肉', '鸡肉'],
  chicken_thigh: ['鸡腿', '鸡肉'],
  pork_lean: ['猪肉', '瘦肉', '里脊'],
  beef_lean: ['牛肉', '牛排', '瘦牛肉'],
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
  shrimp: ['虾仁', '基围虾'],
  salmon: ['鲑鱼'],
  white_fish: ['龙利鱼', '巴沙鱼', '鱼片'],
  seaweed: ['海带丝'],
  mushroom: ['冬菇', '菌菇'],
  cola: ['汽水', '可乐'],
  chips: ['薯条（片）'],
  bread_whole: ['全麦吐司'],
};

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

/** 名称归一化：去掉括号补充、空格、标点，方便比较 */
function normName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')   // 「米饭（熟）」→「米饭」：括号里是生熟说明，不该影响匹配
    .replace(/[\s·・,，。.、!！?？/\-]/g, '');
}

/**
 * 按「名字」找本地食物 —— AI 只给名字和克数，热量必须由本地库算。
 *
 * 为什么要单独做这个：AI 返回的是 `{name, grams}`，没有数据库 id。
 * 以前这里要求 AI 提供 id 或热量（`matchedFoodId` / `kcal`），
 * 但提示词明确禁止 AI 输出热量 —— 结果**每一条都被丢掉**，AI 模式等于没工作。
 *
 * 返回 `{food, score, reason}` 或 null。宁可返回 null，也不要给一个错的食物：
 * 匹配错了比没匹配上更糟（用户看到"炒河粉 116 kcal"会以为准，其实差了一倍）。
 *
 * @param {string} name
 * @param {{ minScore?: number }} options
 */
export function matchFoodByName(name, { minScore = 70 } = {}) {
  const q = normName(name);
  if (!q) return null;

  let best = null;
  const consider = (food, score, reason) => {
    if (!best || score > best.score) best = { food, score, reason };
  };

  for (const food of FOODS) {
    const n = normName(food.name);
    // 1) 名字完全一致（去掉括号说明后）
    if (n === q) { consider(food, 100, '名字一致'); continue; }
    // 2) 别名完全一致
    const aliases = ALIASES[food.id] || [];
    let aliasHit = null;
    for (const a of aliases) {
      if (normName(a) === q) { aliasHit = a; break; }
    }
    if (aliasHit) { consider(food, 95, `别名「${aliasHit}」`); continue; }
    // 3) 一方包含另一方，且重叠部分够长（避免「河粉」匹配到「粉蒸肉」这种）
    const short = n.length <= q.length ? n : q;
    const long = n.length <= q.length ? q : n;
    if (short.length >= 2 && long.includes(short) && short.length / long.length >= 0.5) {
      consider(food, 70 + Math.round((short.length / long.length) * 20), '名字包含');
      continue;
    }
    // 4) 别名包含：AI 说「炒河粉」，库里「米粉/河粉（熟）」的别名有「河粉」
    for (const a of aliases) {
      const na = normName(a);
      if (na.length < 2) continue;
      if (q.includes(na) && na.length / q.length >= 0.5) {
        consider(food, 65 + Math.round((na.length / q.length) * 15), `别名包含「${a}」`);
      }
    }
  }

  if (!best || best.score < minScore) return null;
  return best;
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
