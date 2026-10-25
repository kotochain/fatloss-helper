/**
 * 组合菜（一整顿）数据：面、饭、火锅、烧烤这类「按份吃」的东西。
 *
 * 数值是「一份 = baseGrams 克」的参考值（家常做法估算，误差较大，界面上要让用户确认）。
 *
 * 为什么单独一个文件：
 *  - 离线解析（js/mealparse.js）需要它们的份量语义（一碗牛肉面 = 600 克一份）；
 *  - AI 那条路也要能认出「黄焖鸡米饭」「馄饨」「烧烤」这些词 —— 以前只查食材表，
 *    结果 AI 明明听懂了、本地库里也有这道菜，却因为「只在组合菜表里」而记不上（v31 修的）。
 *  - 搜索页也该搜得到它们。
 * 这两边都要用，所以不能锁在 mealparse.js 里（会形成循环引用）。
 */

export const DISHES = [
  // 面食类
  { id: 'beef_noodle', name: '牛肉面', baseGrams: 600, kcal: 630, protein: 33, fat: 16, carb: 81, aliases: ['牛肉面', '牛腩面', '拉面', '兰州拉面'], ask: '有没有加蛋或加肉？' },
  { id: 'pork_noodle', name: '猪肉/大肉面', baseGrams: 600, kcal: 700, protein: 28, fat: 28, carb: 80, aliases: ['大肉面', '排骨面', '猪肝面', '肉丝面'] },
  { id: 'noodle_soup_plain', name: '面条 / 汤面', baseGrams: 500, kcal: 420, protein: 15, fat: 10, carb: 68, aliases: ['清汤面', '阳春面', '素面', '光面', '面条', '汤面', '面'], ask: '是素面还是有浇头（牛肉/大肉/鸡蛋）？' },
  { id: 'noodle_fried', name: '炒面 / 拌面', baseGrams: 400, kcal: 620, protein: 18, fat: 24, carb: 82, aliases: ['炒面', '拌面', '热干面', '油泼面', '炸酱面'] },
  { id: 'rice_noodle_soup', name: '米粉 / 米线 / 螺蛳粉', baseGrams: 600, kcal: 550, protein: 18, fat: 18, carb: 78, aliases: ['米粉', '米线', '螺蛳粉', '桂林米粉', '过桥米线', '酸辣粉'] },
  { id: 'instant_noodle', name: '方便面（含调料）', baseGrams: 500, kcal: 480, protein: 10, fat: 20, carb: 65, aliases: ['方便面', '泡面', '桶面', '泡面加蛋'] },
  // 饭类
  { id: 'set_rice', name: '盖饭 / 快餐套餐', baseGrams: 500, kcal: 700, protein: 28, fat: 24, carb: 90, aliases: ['盖饭', '盖浇饭', '快餐', '套餐', '便当', '盒饭', '煲仔饭'], generic: true, ask: '主菜是什么？米饭吃完了吗？' },
  { id: 'huangmenji', name: '黄焖鸡米饭', baseGrams: 550, kcal: 780, protein: 35, fat: 30, carb: 92, aliases: ['黄焖鸡', '黄焖鸡米饭'] },
  { id: 'fried_rice_dish', name: '炒饭', baseGrams: 350, kcal: 570, protein: 15, fat: 19, carb: 81, aliases: ['炒饭', '蛋炒饭', '扬州炒饭'] },
  { id: 'canteen_rice', name: '食堂打饭（两菜一饭）', baseGrams: 550, kcal: 650, protein: 25, fat: 22, carb: 85, aliases: ['食堂打饭', '打饭', '两个菜', '三菜一汤', '一份饭', '食堂'], generic: true, ask: '打了几个菜？有肉吗？' },
  // 其他常见
  { id: 'dumpling_meal', name: '饺子（一顿）', baseGrams: 300, kcal: 660, protein: 27, fat: 24, carb: 84, aliases: ['饺子', '水饺', '锅贴'] },
  { id: 'wonton_meal', name: '馄饨 / 云吞（一碗）', baseGrams: 300, kcal: 330, protein: 15, fat: 11, carb: 42, aliases: ['馄饨', '云吞', '抄手'] },
  { id: 'malatang_meal', name: '麻辣烫 / 冒菜（不喝汤）', baseGrams: 500, kcal: 650, protein: 30, fat: 38, carb: 45, aliases: ['麻辣烫', '冒菜', '串串'], ask: '有加芝麻酱或辣油吗？主食加了粉丝还是方便面？' },
  { id: 'hotpot_meal', name: '火锅（一顿）', baseGrams: 600, kcal: 900, protein: 45, fat: 60, carb: 40, aliases: ['火锅', '涮锅', '涮羊肉'], ask: '锅底是清汤还是红油？蘸料用麻酱还是油碟？' },
  { id: 'bbq_meal', name: '烧烤（一顿）', baseGrams: 400, kcal: 850, protein: 40, fat: 60, carb: 30, aliases: ['烧烤', '烤串', '烤肉'], ask: '喝酒了吗？主食吃了吗？' },
  { id: 'burger_meal', name: '汉堡套餐', baseGrams: 500, kcal: 900, protein: 30, fat: 40, carb: 105, aliases: ['汉堡套餐', '麦当劳', '肯德基', '炸鸡套餐'] },
  { id: 'sandwich', name: '三明治 / 轻食沙拉碗', baseGrams: 300, kcal: 380, protein: 22, fat: 14, carb: 42, aliases: ['三明治', '轻食', '沙拉碗', '沙拉', '帕尼尼'], ask: '酱料放了吗？（沙拉酱热量很高）' },
  { id: 'porridge_meal', name: '粥+小菜/包子早餐', baseGrams: 400, kcal: 350, protein: 13, fat: 8, carb: 58, aliases: ['早餐', '粥', '包子', '豆浆油条', '煎饼'] },
  { id: 'yogurt_meal', name: '酸奶+水果', baseGrams: 300, kcal: 250, protein: 10, fat: 6, carb: 38, aliases: ['酸奶水果', '水果捞'] },
];

/**
 * 把「一份」的组合菜换算成「每 100 克」的形状，好和食材走同一套匹配/搜索逻辑。
 * 换算只是为了复用，界面上仍然按「一份 XXX 克」的方式记。
 */
export function dishAsFood(dish) {
  const k = 100 / dish.baseGrams;
  const round1 = (v) => Math.round(v * k * 10) / 10;
  return {
    id: dish.id,
    name: dish.name,
    category: 'dish',
    kcal: round1(dish.kcal),
    protein: round1(dish.protein),
    fat: round1(dish.fat),
    carb: round1(dish.carb),
    servings: [['一份', dish.baseGrams]],
    dishId: dish.id,
    // 组合菜的别名不另存一份，匹配时直接读（见 foods.js 的 aliasList）
    _aliases: dish.aliases,
    generic: Boolean(dish.generic),
    ask: dish.ask || null,
  };
}
