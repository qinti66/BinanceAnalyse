import { redirect } from "next/navigation";

// 站点根路径原来是一个基于静态快照文件（lib/dashboard-data.json）的旧版聪明钱融合看板原型，
// 数据是固定的、不参与任何真实模块的计算（其他页面的规则说明里也明确写着"旧版固定快照，不参与本页计算"），
// 导航栏（components/module-nav.tsx）里也没有它。直接访问站点根路径时先看到这个假数据看板容易让人误以为它是真实结果，
// 所以改成直接跳到第一个真实模块。旧看板原样搬到了 /legacy-dashboard，不是删除，交叉验证页的"查看旧版固定快照"链接也指向那里。
export default function Home() {
  redirect("/square");
}
