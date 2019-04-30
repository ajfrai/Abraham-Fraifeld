//
//  main.cpp
//  LinkedList
//
//  Created by Abraham Fraifeld on 4/26/19.
//  Copyright © 2019 Abraham Fraifeld. All rights reserved.
//

#include <iostream>
#include "LL.hpp"

int main(int argc, const char * argv[]) {
    // insert code here...
    list<float> l;
    l.readFile("/Users/fraifeld-mba/Desktop/Abraham-Fraifeld/Algorithms-Training/LinkedList/LinkedList/ll-test.txt");
    l.printList();
}
