//
//  LL.cpp
//  
//
//  Created by Abraham Fraifeld on 4/26/19.
//
//

#include "LL.hpp"

Node::Node(){
    cout << "Constructed Node";
}
void Node::print_hello()
{
    cout << "Hello World";
}

int main(){
    Node n = Node();
    n.print_hello();
    return 0
    
}
